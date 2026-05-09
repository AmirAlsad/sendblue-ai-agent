import type { Express, Request, Response } from 'express';
import type pino from 'pino';
import type { AgentConfig } from '../config/env.js';
import type { ConversationStore } from '../conversation/store.js';
import type { BufferScheduler } from '../conversation/scheduler.js';
import type { LimitTracker } from '../limits/tracker.js';
import type { InMemoryStatusStore } from '../status/tracker.js';
import { validateAdminToken } from './auth.js';
import { redactConversationRecord, redactStatusRecord } from './redaction.js';

/**
 * Mount read-only admin routes for limit telemetry and live introspection.
 *
 * Routes:
 * - `GET /admin/limits?lineNumber=+1...` — current `LimitSnapshot`.
 * - `GET /admin/conversations/:key` — conversation record (PII-redacted by
 *   default; pass `?reveal=true` to unmask).
 * - `GET /admin/status/:messageHandle` — accumulated `StatusRecord` history
 *   (redacted by default).
 * - `GET /admin/queue` — buffer scheduler queue counts.
 * - `GET /admin/dedupe?messageHandle=...` — single-key inbound dedupe check
 *   (true if a recent webhook with that handle was claimed).
 *
 * Auth posture: header `authorization: Bearer <token>` (or `x-admin-api-token: <token>`)
 * compared against `ADMIN_API_TOKEN` via `crypto.timingSafeEqual`. **None of
 * the routes mount when `adminApiToken` is unset** so a misconfigured deploy
 * cannot accidentally expose live state.
 */
export function mountAdminRoutes(args: {
  app: Express;
  config: AgentConfig;
  limitTracker: LimitTracker;
  conversationStore?: ConversationStore;
  statusStore?: InMemoryStatusStore;
  bufferScheduler?: BufferScheduler;
  logger: pino.Logger;
}): boolean {
  const { app, config, limitTracker, conversationStore, statusStore, bufferScheduler, logger } = args;
  if (!config.adminApiToken) {
    logger.debug('ADMIN_API_TOKEN not set — admin routes not mounted');
    return false;
  }

  const expected = config.adminApiToken;
  const guard = (req: Request, res: Response): boolean => {
    if (validateAdminToken(req, expected)) return true;
    logger.warn(
      { path: req.path, remoteIp: req.ip, userAgent: req.get('user-agent') },
      'rejected admin request with invalid token'
    );
    res.status(401).json({ error: 'invalid admin token' });
    return false;
  };

  app.get('/admin/limits', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const lineNumber = readLineNumber(req) ?? config.sendblueFromNumber;
    try {
      const snapshot = await limitTracker.snapshot(lineNumber);
      res.status(200).json({ snapshot });
    } catch (error) {
      logger.warn({ err: error, lineNumber }, 'failed to compute limit snapshot');
      res.status(500).json({ error: 'failed to compute snapshot' });
    }
  });

  app.get('/admin/conversations/:key', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    if (!conversationStore) {
      res.status(503).json({ error: 'conversation store not wired' });
      return;
    }
    const reveal = readReveal(req);
    const key = pathParam(req, 'key');
    try {
      const record = await conversationStore.getConversation(key);
      if (!record) {
        res.status(404).json({ error: 'conversation not found' });
        return;
      }
      res.status(200).json({ record: reveal ? record : redactConversationRecord(record) });
    } catch (error) {
      logger.warn({ err: error, key }, 'failed to fetch conversation record');
      res.status(500).json({ error: 'failed to fetch conversation' });
    }
  });

  app.get('/admin/status/:messageHandle', (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    if (!statusStore) {
      res.status(503).json({ error: 'status store not wired' });
      return;
    }
    const reveal = readReveal(req);
    const record = statusStore.get(pathParam(req, 'messageHandle'));
    if (!record) {
      res.status(404).json({ error: 'status record not found' });
      return;
    }
    res.status(200).json({ record: reveal ? record : redactStatusRecord(record) });
  });

  app.get('/admin/queue', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    if (!bufferScheduler) {
      res.status(503).json({ error: 'buffer scheduler not wired' });
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const stats =
        (await Promise.race([
          bufferScheduler.getStats?.() ?? Promise.resolve({}),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('scheduler getStats timeout')),
              config.readyRedisTimeoutMs
            );
          })
        ])) ?? {};
      res.status(200).json({ kind: bufferScheduler.kind, stats });
    } catch (error) {
      logger.warn({ err: error }, 'failed to fetch buffer scheduler stats');
      res.status(500).json({ error: 'failed to fetch queue stats' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  app.get('/admin/dedupe', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    if (!conversationStore) {
      res.status(503).json({ error: 'conversation store not wired' });
      return;
    }
    const messageHandle = readMessageHandle(req);
    if (!messageHandle) {
      res.status(400).json({ error: 'messageHandle query parameter is required' });
      return;
    }
    try {
      const result = await conversationStore.peekInboundHandle(messageHandle);
      res.status(200).json({
        messageHandle,
        present: result.present,
        ttl_s: result.ttlSeconds
      });
    } catch (error) {
      logger.warn({ err: error, messageHandle }, 'failed to probe inbound dedupe');
      res.status(500).json({ error: 'failed to probe dedupe' });
    }
  });

  return true;
}

function readLineNumber(req: Request): string | undefined {
  const value = req.query?.lineNumber;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

function readMessageHandle(req: Request): string | undefined {
  const value = req.query?.messageHandle;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

function readReveal(req: Request): boolean {
  const value = req.query?.reveal;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}
