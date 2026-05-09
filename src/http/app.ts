import { createRequire } from 'node:module';
import express, { type Request, type Response } from 'express';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { AgentConfig } from '../config/env.js';
import { type ChatClient, ChatEndpointError } from '../chat/client.js';
import { ConversationAgent } from '../conversation/agent.js';
import { BullMqBufferScheduler, InMemoryBufferScheduler, type BufferScheduler } from '../conversation/scheduler.js';
import { InMemoryConversationStore, type ConversationStore } from '../conversation/store.js';
import { RedisConversationStore } from '../conversation/redis-store.js';
import { HttpIdentityResolver, type IdentityResolver } from '../identity/resolver.js';
import { InMemoryLimitCounterStore, type LimitCounterStore } from '../limits/store.js';
import { RedisLimitCounterStore } from '../limits/redis-store.js';
import { InMemorySmsLimitStallScheduler, type SmsLimitStallScheduler } from '../limits/retry.js';
import { createLimitTracker, type LimitTracker } from '../limits/tracker.js';
import {
  InMemoryMetricsCollector,
  NoopMetricsCollector,
  type MetricsCollector
} from '../metrics/collector.js';
import { renderPrometheus, PROMETHEUS_CONTENT_TYPE } from '../metrics/prometheus.js';
import { createAgentMetrics, type AgentMetrics } from '../metrics/registry.js';
import { type SendblueClient } from '../sendblue/client.js';
import {
  parseOperationalWebhook,
  parseReceiveWebhook,
  parseStatusWebhook,
  parseTypingIndicatorWebhook
} from '../sendblue/parser.js';
import {
  SENDBLUE_WEBHOOK_TYPES,
  sendblueOperationalWebhookTypeFromPath,
  sendblueWebhookPath
} from '../sendblue/webhook-types.js';
import { InMemoryStatusStore } from '../status/tracker.js';
import { mountAdminRoutes } from './admin.js';
import { validateAdminToken } from './auth.js';
import { validateStatusCallbackSecret, validateWebhookSecret } from './security.js';
import { requestContextFromLocals, traceMiddleware } from './trace.js';

const require = createRequire(import.meta.url);
const AGENT_VERSION: string = (() => {
  try {
    const pkg = require('../../package.json') as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

export type AppDependencies = {
  config: AgentConfig;
  chatClient: ChatClient;
  sendblueClient: SendblueClient;
  statusStore?: InMemoryStatusStore;
  conversationStore?: ConversationStore;
  bufferScheduler?: BufferScheduler;
  identityResolver?: IdentityResolver;
  /** Override the limit tracker (defaults to an in-memory tracker). */
  limitTracker?: LimitTracker;
  /** Override the limit counter store (defaults to in-memory). */
  limitCounterStore?: LimitCounterStore;
  /** Override the SMS-limit stall scheduler (defaults to in-memory). */
  smsLimitStallScheduler?: SmsLimitStallScheduler;
  /** Optional metrics collector. When omitted, a no-op collector is used. */
  metrics?: MetricsCollector;
  webhookObserver?: (envelope: ObservedWebhookEnvelope) => void | Promise<void>;
  logger?: pino.Logger;
};

export type ObservedWebhookEnvelope = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string;
  receivedAt: string;
  path: string;
};

type RawBodyRequest = Request & { rawBody?: string };

/**
 * Composes the Express webhook ingress for the Sendblue agent.
 *
 * Routes mounted:
 * - `GET /health` — liveness probe.
 * - `POST /webhook/receive` — inbound message webhook. Dedupes on
 *   `message_handle` and hands off to {@link ConversationAgent.handleReceive}.
 *   Returns 202 on accepted, 200 on dedupe-drop, 400 on parse failure, 401 on
 *   invalid secret, 502 on downstream chat failure.
 * - `POST /webhook/status` — outbound status callback. Returns 200 on success
 *   so Sendblue does not retry, 400 on parse failure, 401 on invalid secret.
 * - `POST /webhook/typing-indicator` — inbound typing webhook (account-gated
 *   even though the type is documented). Returns 202 on success, 400 on parse
 *   failure, 401 on invalid secret.
 * - `POST /webhook/{call-log,line-blocked,line-assigned,contact-created}` —
 *   operational webhooks parsed generically for forward compatibility.
 *
 * Status code policy is aligned with Sendblue's documented retry behavior:
 * "Sendblue retries webhook delivery up to 3 times if your endpoint returns a
 * 5xx server error" (https://docs.sendblue.com/getting-started/webhooks). All
 * non-retryable conditions (auth failure, malformed payload, downstream chat
 * failure) return 4xx so Sendblue does not retry; transport-side retry is
 * handled by the conversation/outbound layer instead.
 *
 * Webhook secret validation is shared-secret only. Sendblue documents the
 * header name as `sb-signing-secret` (https://docs.sendblue.com/security). The
 * header name is configurable via `SENDBLUE_WEBHOOK_SECRET_HEADER` for
 * compatibility with legacy installs; both the configured name and the
 * documented literal are accepted.
 */
export function createApp(deps: AppDependencies) {
  const app = express();
  const statusStore = deps.statusStore ?? new InMemoryStatusStore();
  const logger = deps.logger ?? pino({ level: process.env.LOG_LEVEL || 'info' });
  // Default to an in-memory collector so the standard `start()` entry point
  // produces a populated `/metrics` body out of the box. Callers that want
  // tracking off can pass `metrics: new NoopMetricsCollector()` explicitly,
  // and the noop is also exported from `src/index.ts` for that case.
  const metricsCollector: MetricsCollector =
    deps.metrics ??
    new InMemoryMetricsCollector({
      cardinalityLimit: deps.config.metricsLabelCardinalityLimit,
      logger
    });
  const metrics: AgentMetrics = createAgentMetrics(metricsCollector);
  metrics.agentUp.set(undefined, 1);
  metrics.agentBuildInfo.set({ version: AGENT_VERSION }, 1);
  const conversationStore =
    deps.conversationStore ??
    (deps.config.redisUrl
      ? new RedisConversationStore(deps.config)
      : new InMemoryConversationStore(deps.config));
  const bufferScheduler =
    deps.bufferScheduler ??
    (deps.config.redisUrl
      ? new BullMqBufferScheduler(deps.config, logger, metrics)
      : new InMemoryBufferScheduler(metrics));
  const identityResolver =
    deps.identityResolver ??
    (deps.config.userLookupUrl ? new HttpIdentityResolver(deps.config) : undefined);
  const limitCounterStore =
    deps.limitCounterStore ??
    (deps.config.redisUrl
      ? new RedisLimitCounterStore(deps.config)
      : new InMemoryLimitCounterStore());
  const limitTracker =
    deps.limitTracker ??
    createLimitTracker({ config: deps.config, store: limitCounterStore, logger, metrics });
  const smsLimitStallScheduler = deps.smsLimitStallScheduler ?? new InMemorySmsLimitStallScheduler();
  const conversationAgent = new ConversationAgent({
    config: deps.config,
    chatClient: deps.chatClient,
    sendblueClient: deps.sendblueClient,
    statusStore,
    store: conversationStore,
    scheduler: bufferScheduler,
    identityResolver,
    limitTracker,
    smsLimitStallScheduler,
    metrics,
    logger
  });

  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buffer) => {
        (req as RawBodyRequest).rawBody = buffer.toString('utf8');
      }
    })
  );
  app.use(traceMiddleware({ logger }));

  const startedAt = new Date();
  const startedAtMs = startedAt.getTime();
  const redisProbe = deps.config.redisUrl
    ? new Redis(deps.config.redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: deps.config.readyRedisTimeoutMs,
        lazyConnect: true,
        enableOfflineQueue: false,
        // Disable the background reconnect loop. The probe is one-shot:
        // each /ready hit either gets an in-bounds latency or the
        // race-based timeout in pingRedis fires. Without this, ioredis's
        // exponential reconnect timer keeps a socket+timer alive forever
        // when Redis is unreachable.
        retryStrategy: () => null
      })
    : undefined;

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptime_s: Math.floor((Date.now() - startedAtMs) / 1000),
      version: AGENT_VERSION,
      node_version: process.version
    });
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    const redis = redisProbe
      ? await pingRedis(redisProbe, deps.config.readyRedisTimeoutMs)
      : { ok: true as const, kind: 'in_memory' as const };
    let scheduler: { ok: true; kind: string; stats?: unknown } | { ok: false; kind: string; error: string };
    try {
      const stats =
        (await withTimeout(
          () => bufferScheduler.getStats?.() ?? Promise.resolve({}),
          deps.config.readyRedisTimeoutMs,
          'scheduler getStats timeout'
        )) ?? {};
      scheduler = { ok: true, kind: bufferScheduler.kind, stats };
    } catch (error) {
      scheduler = {
        ok: false,
        kind: bufferScheduler.kind,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    const ok = redis.ok && scheduler.ok;
    res.status(ok ? 200 : 503).json({
      ok,
      started_at: startedAt.toISOString(),
      redis,
      scheduler
    });
  });

  app.post('/webhook/receive', async (req: Request, res: Response) => {
    const ctx = requestContextFromLocals(res);
    const reqLogger = ctx?.logger ?? logger;
    await observeWebhook(req, deps.webhookObserver, reqLogger);
    if (!validateWebhookSecret(req, deps.config)) {
      logSecretRejection(reqLogger, req, 'receive');
      metrics.webhookSecretRejections.inc({ route: 'receive' });
      metrics.webhookReceived.inc({ type: 'receive', result: 'rejected' });
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }

    let webhook;
    try {
      webhook = parseReceiveWebhook(req.body);
    } catch (error) {
      reqLogger.warn({ err: error, path: req.path }, 'failed to parse receive webhook');
      metrics.webhookParseFailures.inc({ type: 'receive', reason: parseErrorReason(error) });
      metrics.webhookReceived.inc({ type: 'receive', result: 'rejected' });
      res.status(400).json({ error: error instanceof Error ? error.message : 'invalid payload' });
      return;
    }

    try {
      const result = await conversationAgent.handleReceive(webhook, ctx);
      const dropped = 'duplicate' in result && result.duplicate;
      metrics.webhookReceived.inc({
        type: 'receive',
        result: dropped ? 'dropped' : 'accepted'
      });
      res.status(dropped ? 200 : 202).json(result);
    } catch (error) {
      reqLogger.warn(
        {
          err: error,
          messageHandle: webhook.messageHandle,
          chatEndpointError: error instanceof ChatEndpointError
        },
        'failed to process receive webhook'
      );
      metrics.webhookReceived.inc({ type: 'receive', result: 'error' });
      res.status(502).json({ error: 'failed to process message' });
    }
  });

  app.post('/webhook/status', async (req: Request, res: Response) => {
    const ctx = requestContextFromLocals(res);
    const reqLogger = ctx?.logger ?? logger;
    await observeWebhook(req, deps.webhookObserver, reqLogger);
    if (!validateStatusCallbackSecret(req, deps.config)) {
      logSecretRejection(reqLogger, req, 'status');
      metrics.webhookSecretRejections.inc({ route: 'status' });
      metrics.webhookReceived.inc({ type: 'status', result: 'rejected' });
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }

    try {
      const update = parseStatusWebhook(req.body);
      const result = await conversationAgent.handleStatus(update, ctx);
      metrics.webhookReceived.inc({ type: 'status', result: 'accepted' });
      res.status(200).json(result);
    } catch (error) {
      reqLogger.warn({ err: error }, 'failed to process status callback');
      metrics.webhookParseFailures.inc({ type: 'status', reason: parseErrorReason(error) });
      metrics.webhookReceived.inc({ type: 'status', result: 'rejected' });
      res.status(400).json({ error: error instanceof Error ? error.message : 'invalid payload' });
    }
  });

  app.post('/webhook/typing-indicator', async (req: Request, res: Response) => {
    const ctx = requestContextFromLocals(res);
    const reqLogger = ctx?.logger ?? logger;
    await observeWebhook(req, deps.webhookObserver, reqLogger);
    if (!validateWebhookSecret(req, deps.config)) {
      logSecretRejection(reqLogger, req, 'typing_indicator');
      metrics.webhookSecretRejections.inc({ route: 'typing_indicator' });
      metrics.webhookReceived.inc({ type: 'typing_indicator', result: 'rejected' });
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }

    try {
      const webhook = parseTypingIndicatorWebhook(req.body);
      const result = await conversationAgent.handleTyping(webhook, ctx);
      metrics.webhookReceived.inc({ type: 'typing_indicator', result: 'accepted' });
      res.status(202).json(result);
    } catch (error) {
      reqLogger.warn({ err: error, path: req.path }, 'failed to process typing indicator webhook');
      metrics.webhookParseFailures.inc({ type: 'typing_indicator', reason: parseErrorReason(error) });
      metrics.webhookReceived.inc({ type: 'typing_indicator', result: 'rejected' });
      res.status(400).json({ error: error instanceof Error ? error.message : 'invalid payload' });
    }
  });

  app.post(
    SENDBLUE_WEBHOOK_TYPES.filter(
      type => type !== 'receive' && type !== 'outbound' && type !== 'typing_indicator'
    ).map(sendblueWebhookPath),
    async (req: Request, res: Response) => {
      const ctx = requestContextFromLocals(res);
      const reqLogger = ctx?.logger ?? logger;
      await observeWebhook(req, deps.webhookObserver, reqLogger);
      const webhookType = sendblueOperationalWebhookTypeFromPath(req.path);
      if (!validateWebhookSecret(req, deps.config)) {
        logSecretRejection(reqLogger, req, webhookType ?? 'operational');
        metrics.webhookSecretRejections.inc({ route: webhookType ?? 'operational' });
        metrics.webhookReceived.inc({ type: 'operational', result: 'rejected' });
        res.status(401).json({ error: 'invalid webhook secret' });
        return;
      }

      try {
        const webhook = parseOperationalWebhook(req.body);
        reqLogger.info(
          {
            webhookType,
            messageHandle: webhook.messageHandle,
            status: webhook.status,
            path: req.path
          },
          'received Sendblue operational webhook'
        );
        metrics.webhookReceived.inc({ type: 'operational', result: 'accepted' });
        res.status(202).json({ ok: true, type: webhookType });
      } catch (error) {
        reqLogger.warn(
          { err: error, webhookType, path: req.path },
          'failed to parse Sendblue operational webhook'
        );
        metrics.webhookParseFailures.inc({ type: 'operational', reason: parseErrorReason(error) });
        metrics.webhookReceived.inc({ type: 'operational', result: 'rejected' });
        res.status(400).json({ error: error instanceof Error ? error.message : 'invalid payload' });
      }
    }
  );

  mountAdminRoutes({
    app,
    config: deps.config,
    limitTracker,
    conversationStore,
    statusStore,
    bufferScheduler,
    logger
  });
  mountMetricsRoute({ app, config: deps.config, collector: metricsCollector, logger });

  // Best-effort, non-blocking recovery of transient-retry and SMS-limit-
  // stall timers persisted from a previous process. Slow Redis SCANs must
  // not gate startup, so this fires-and-forgets. Failures are logged and
  // swallowed by `recoverPendingRetries`.
  void conversationAgent
    .recoverPendingRetries()
    .then(({ smsStallsResumed, transientRetriesResumed }) => {
      if (smsStallsResumed === 0 && transientRetriesResumed === 0) return;
      logger.info(
        { smsStallsResumed, transientRetriesResumed },
        'resumed pending retries from persisted state'
      );
    })
    .catch(error => {
      logger.warn({ err: error }, 'recoverPendingRetries threw');
    });

  return {
    app,
    statusStore,
    conversationAgent,
    conversationStore,
    metrics,
    metricsCollector,
    close: async () => {
      await conversationAgent.close();
      if (redisProbe) redisProbe.disconnect();
    }
  };
}

async function pingRedis(
  client: Redis,
  timeoutMs: number
): Promise<{ ok: true; kind: 'redis'; latency_ms: number } | { ok: false; kind: 'redis'; latency_ms: number; error: string }> {
  const startedAt = Date.now();
  try {
    const result = await withTimeout(() => client.ping(), timeoutMs, 'redis ping timeout');
    if (result !== 'PONG') {
      return {
        ok: false,
        kind: 'redis',
        latency_ms: Date.now() - startedAt,
        error: `unexpected ping response: ${result}`
      };
    }
    return { ok: true, kind: 'redis', latency_ms: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      kind: 'redis',
      latency_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Race a promise-producing thunk against a timeout. Always clears the timer
 * after the race settles so a successful operation does not leak a pending
 * setTimeout that would later fire reject() on an already-resolved promise.
 */
async function withTimeout<T>(thunk: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      thunk(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mountMetricsRoute(args: {
  app: express.Express;
  config: AgentConfig;
  collector: MetricsCollector;
  logger: pino.Logger;
}): void {
  const { app, config, collector, logger } = args;
  if (!config.adminApiToken) {
    logger.debug('ADMIN_API_TOKEN not set — /metrics route not mounted');
    return;
  }
  const expected = config.adminApiToken;

  app.get('/metrics', (req: Request, res: Response) => {
    if (!validateAdminToken(req, expected)) {
      logger.warn(
        { path: req.path, remoteIp: req.ip, userAgent: req.get('user-agent') },
        'rejected /metrics request with invalid token'
      );
      res.status(401).json({ error: 'invalid admin token' });
      return;
    }

    const text = renderPrometheus(collector.snapshot());
    res.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE);
    res.status(200).send(text);
  });
}

function logSecretRejection(logger: pino.Logger, req: Request, route: string): void {
  // We deliberately do not log the provided header value, only its presence and
  // size. Sendblue's secret is a literal shared string, so leaking it via logs
  // would be as bad as leaking the configured value.
  const headerNames = ['sb-signing-secret', 'sb-signing-secret-header'];
  const presentHeaders = Object.keys(req.headers).filter(name => /^sb[-_]/i.test(name));
  logger.warn(
    {
      route,
      path: req.path,
      headerNames,
      presentSendblueHeaders: presentHeaders,
      remoteIp: req.ip,
      userAgent: req.get('user-agent')
    },
    'rejected Sendblue webhook with invalid secret'
  );
}

async function observeWebhook(
  req: Request,
  observer: AppDependencies['webhookObserver'],
  logger: pino.Logger
): Promise<void> {
  if (!observer) return;

  try {
    await observer({
      headers: req.headers,
      body: req.body,
      rawBody: (req as RawBodyRequest).rawBody,
      receivedAt: new Date().toISOString(),
      path: req.path
    });
  } catch (error) {
    logger.warn({ err: error, path: req.path }, 'webhook observer failed');
  }
}

function parseErrorReason(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (/missing|required/.test(message)) return 'missing_field';
    if (/invalid|malformed|unexpected/.test(message)) return 'malformed';
    if (/unsupported|unknown/.test(message)) return 'unsupported';
  }
  return 'other';
}
