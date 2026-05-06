import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import pino from 'pino';
import { HttpChatClient } from '../../src/chat/client.js';
import type { ChatEndpointRequest } from '../../src/chat/types.js';
import { loadConfig } from '../../src/config/env.js';
import { createApp } from '../../src/http/app.js';
import { HttpSendblueClient } from '../../src/sendblue/client.js';
import { CAPTURE_MANAGED_WEBHOOK_TYPES } from '../../src/sendblue/webhook-types.js';
import { InMemoryStatusStore } from '../../src/status/tracker.js';
import { assertEnv, loadDotenvFiles, mergeRuntimeEnv, readSetupEnv } from './lib/env.js';
import {
  createShowcaseCaptureSink,
  formatShowcasePrompt,
  InstrumentedSendblueClient,
  isSkipContent,
  listShowcaseScenarios,
  selectShowcaseScenarios,
  startShowcaseChatEndpoint,
  summarizeShowcaseStep,
  type ShowcaseCaptureEnvelope,
  type ShowcaseScenario,
  type ShowcaseStepSummary
} from './lib/showcase.js';
import { sendCapturePrompt } from './lib/guided-capture.js';
import { startNgrokTunnel, type StartedNgrokTunnel } from './lib/ngrok.js';
import { SendblueWebhookClient } from './lib/sendblue-webhooks.js';

const DEFAULT_SETTLE_MS = 5000;
const SHOWCASE_MANAGED_WEBHOOK_TYPES = CAPTURE_MANAGED_WEBHOOK_TYPES.filter(type => type !== 'typing_indicator');

const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log('Available Sendblue showcase scenarios:');
  for (const scenario of listShowcaseScenarios()) console.log(`- ${scenario}`);
  process.exit(0);
}

const selectedScenarios = selectShowcaseScenarios(args);
const env = readSetupEnv();
assertEnv(env, 'capture');

const startedAt = new Date().toISOString();
const sessionId = randomUUID().slice(0, 8);
const outputDir = resolve('.captures/sendblue-showcase', sessionId);
const rawEnv = { ...loadDotenvFiles(), ...process.env };
const mediaUrl = readShowcaseMediaUrl(rawEnv);
const agentDisplayName = rawEnv.AGENT_DISPLAY_NAME || 'sb-agent';
const readTypingDelayMs = readInt(rawEnv.SHOWCASE_READ_TYPING_DELAY_MS, 15000);
let activeScenario: { id: string; title: string } | undefined;
let ngrok: StartedNgrokTunnel | undefined;
let agentServer: Server | undefined;
let shuttingDown = false;
let typingWebhookPersisted: boolean | undefined;
const scenarioByMessageHandle = new Map<string, { id: string; title: string }>();

const capture = createShowcaseCaptureSink(outputDir);
const chat = await startShowcaseChatEndpoint({
  mediaUrl,
  agentDisplayName,
  readTypingDelayMs,
  currentScenarioId: () => activeScenario?.id,
  scenarioForRequest: request => scenarioForBufferedRequest(request, scenarioByMessageHandle),
  typingWebhookAvailable: () => typingWebhookPersisted
});

const publicBaseUrl = env.e2ePublicBaseUrl ?? (ngrok = await startNgrokTunnel(env)).publicUrl;
const runtimeEnv = mergeRuntimeEnv(env, publicBaseUrl, chat.url);
Object.assign(process.env, runtimeEnv);

const config = loadConfig({
  ...process.env,
  PORT: String(env.agentPort),
  PUBLIC_BASE_URL: publicBaseUrl,
  CHAT_ENDPOINT_URL: chat.url,
  CHAT_ENDPOINT_TIMEOUT_MS: rawEnv.SHOWCASE_CHAT_ENDPOINT_TIMEOUT_MS || process.env.CHAT_ENDPOINT_TIMEOUT_MS || '30000',
  SENDBLUE_API_BASE_URL: env.sendblueApiBaseUrl,
  SENDBLUE_API_KEY_ID: env.sendblueApiKeyId!,
  SENDBLUE_API_SECRET_KEY: env.sendblueApiSecretKey!,
  SENDBLUE_FROM_NUMBER: env.sendblueFromNumber!,
  SENDBLUE_WEBHOOK_SECRET: env.sendblueWebhookSecret,
  SENDBLUE_WEBHOOK_SECRET_HEADER: env.sendblueWebhookSecretHeader,
  OUTBOUND_TYPING_INDICATORS_ENABLED: 'true',
  READ_RECEIPTS_ENABLED: 'true',
  READ_RECEIPT_DEBOUNCE_MS: rawEnv.READ_RECEIPT_DEBOUNCE_MS || '0',
  TYPING_REFRESH_INTERVAL_MS: rawEnv.SHOWCASE_TYPING_REFRESH_INTERVAL_MS || '1500',
  TYPING_REFRESH_MAX_MS: rawEnv.SHOWCASE_TYPING_REFRESH_MAX_MS || '25000',
  BUFFER_BASE_TIMEOUT_MS: rawEnv.SHOWCASE_BUFFER_BASE_TIMEOUT_MS || '10000',
  BUFFER_GROWTH_FACTOR: rawEnv.SHOWCASE_BUFFER_GROWTH_FACTOR || '1.35',
  BUFFER_MAX_TIMEOUT_MS: rawEnv.SHOWCASE_BUFFER_MAX_TIMEOUT_MS || '15000',
  BUFFER_NOISE_MAX_DEVIATION: rawEnv.SHOWCASE_BUFFER_NOISE_MAX_DEVIATION || '0',
  AGENT_DISPLAY_NAME: agentDisplayName
});

const sendblueClient = new InstrumentedSendblueClient(new HttpSendblueClient(config));
const agent = createApp({
  config,
  chatClient: new HttpChatClient(config),
  sendblueClient,
  statusStore: new InMemoryStatusStore(),
  logger: pino({ level: process.env.LOG_LEVEL || 'info' }),
  webhookObserver: envelope => {
    const messageHandle = readEnvelopeMessageHandle(envelope);
    if (messageHandle && activeScenario && envelope.path === '/webhook/receive') {
      scenarioByMessageHandle.set(messageHandle, activeScenario);
    }
    return capture.record(envelope, {
      sessionId,
      scenarioId: activeScenario?.id,
      scenarioTitle: activeScenario?.title
    });
  }
});

agentServer = await listen(agent.app, env.agentPort);
const webhookResults = await new SendblueWebhookClient(env).apply(publicBaseUrl, {
  types: SHOWCASE_MANAGED_WEBHOOK_TYPES
});
const typingWebhookRegistration = await tryRegisterTypingIndicatorWebhook(env, rawEnv, publicBaseUrl);
typingWebhookPersisted = typingWebhookRegistration.persisted;
const summaries: ShowcaseStepSummary[] = [];

process.once('SIGINT', () => {
  shuttingDown = true;
  shutdown()
    .catch(error => console.error(error))
    .finally(() => process.exit(130));
});

process.once('SIGTERM', () => {
  shuttingDown = true;
  shutdown()
    .catch(error => console.error(error))
    .finally(() => process.exit(143));
});

console.log('\nLive Sendblue showcase is running.');
console.log(`Session: ${sessionId}`);
console.log(`Agent: http://127.0.0.1:${env.agentPort}`);
console.log(`Public URL: ${publicBaseUrl}`);
console.log(`Chat endpoint: ${chat.url}`);
console.log(`Writing captures and summary to: ${outputDir}`);
console.log(`Outbound hosted media: ${mediaUrl ? mediaUrl : 'not configured; outbound media step will explain the skip'}`);
for (const result of webhookResults) console.log(`Sendblue ${result.type}: ${result.action} ${result.url}`);
console.log(
  `Sendblue typing_indicator: ${typingWebhookRegistration.persisted ? 'registered' : 'not registered'} ${typingWebhookRegistration.url}`
);
if (!typingWebhookRegistration.persisted) {
  console.log(`Typing webhook diagnostic: ${typingWebhookRegistration.message}`);
}
console.log('\nEach step sends an instruction to E2E_TEST_DEVICE_NUMBER.');
console.log('Complete the requested action on your device. Reply "skip" to move past the current step.');
console.log('Use Ctrl+C to stop early. Raw captures may contain secrets, phone numbers, and message content.\n');

try {
  for (const [index, scenario] of selectedScenarios.entries()) {
    if (shuttingDown) break;

    activeScenario = { id: scenario.id, title: scenario.title };
    const beforeEnvelopeCount = capture.envelopes.length;
    const beforeCallCount = sendblueClient.calls.length;
    const beforeExchangeCount = chat.exchanges.length;
    const prompt = formatShowcasePrompt({
      scenario,
      sessionId,
      index: index + 1,
      total: selectedScenarios.length
    });

    await sendCapturePrompt(env, {
      toNumber: env.testDeviceNumber!,
      content: prompt,
      statusCallback: `${publicBaseUrl}/webhook/status`
    });

    console.log(`\n[${index + 1}/${selectedScenarios.length}] ${scenario.title}`);
    if (scenario.optional) console.log('Optional. Reply "skip" to move on without capturing it.');
    console.log(`Waiting for ${scenario.expectedReceiveCount} receive webhook(s)...`);

    const result = await waitForScenario(
      capture.envelopes,
      chat.exchanges,
      sendblueClient.calls,
      scenario,
      beforeEnvelopeCount,
      beforeExchangeCount,
      beforeCallCount
    );
    await delay(scenario.settleMs ?? DEFAULT_SETTLE_MS);
    await waitForQuietStep(capture.envelopes, sendblueClient.calls, chat.exchanges, {
      beforeEnvelopeCount,
      beforeCallCount,
      beforeExchangeCount,
      quietMs: scenario.id === 'xml-compat' ? 4000 : 2500,
      maxMs: 20000
    });

    const stepEnvelopes = capture.envelopes.slice(beforeEnvelopeCount);
    const stepCalls = sendblueClient.calls.slice(beforeCallCount);
    const stepExchanges = chat.exchanges
      .slice(beforeExchangeCount)
      .filter(exchange => exchange.scenarioId === scenario.id || !exchange.scenarioId);
    const summary = summarizeShowcaseStep({
      scenario,
      skipped: result.skipped,
      matched: result.matched,
      envelopes: stepEnvelopes,
      calls: stepCalls,
      exchanges: stepExchanges
    });
    summaries.push(summary);

    const marker = summary.skipped ? 'skipped' : summary.matched ? 'matched' : 'incomplete';
    console.log(
      `Step ${marker}: ${summary.receiveCount} receive, ${summary.statusCount} status, ${summary.messageCount} message, ${summary.reactionCount} reaction, ${summary.readReceiptCount} read receipt, ${summary.typingCount} typing calls.`
    );
    if (summary.typingCount > 0) {
      console.log(`Typing API results: ${summary.typingSucceededCount} succeeded, ${summary.typingFailedCount} failed.`);
    }
    if (summary.readReceiptCount > 0) {
      console.log(
        `Mark-read API results: ${summary.readReceiptSucceededCount} succeeded, ${summary.readReceiptFailedCount} failed.`
      );
    }
    if (summary.chatRequestCount > 0) {
      console.log(`Chat endpoint calls: ${summary.chatRequestCount}; max buffered messages: ${summary.maxBufferedMessageCount}`);
    }
    if (summary.inboundTypingWebhookCount > 0) {
      console.log(`Inbound typing webhooks: ${summary.inboundTypingWebhookCount}`);
    }
    if (summary.understood) console.log(`Understood: ${summary.understood}`);
  }

  await writeSummary(outputDir, {
    sessionId,
    publicBaseUrl,
    chatEndpointUrl: chat.url,
    mediaUrl: mediaUrl ?? null,
    typingWebhookRegistration,
    startedAt,
    completedAt: new Date().toISOString(),
    outputDir,
    steps: summaries
  });
  console.log('\nSendblue showcase complete.');
  console.log(`Summary written to: ${resolve(outputDir, 'summary.json')}`);
} finally {
  await shutdown();
}

async function waitForScenario(
  envelopes: ShowcaseCaptureEnvelope[],
  exchanges: Array<{ scenarioId?: string; messageCount: number; at: string }>,
  calls: Array<{ kind: string; at: string }>,
  scenario: ShowcaseScenario,
  beforeEnvelopeCount: number,
  beforeExchangeCount: number,
  beforeCallCount: number
): Promise<{ matched: boolean; skipped: boolean }> {
  const startedAt = Date.now();
  while (!shuttingDown) {
    const current = envelopes.slice(beforeEnvelopeCount).filter(envelope => envelope.capture?.scenarioId === scenario.id);
    const currentExchanges = exchanges
      .slice(beforeExchangeCount)
      .filter(exchange => exchange.scenarioId === scenario.id || !exchange.scenarioId);
    if (hasSkipReply(current)) return { matched: false, skipped: true };
    const receiveCount = current.filter(envelope => envelope.path === '/webhook/receive').length;
    const maxBufferedMessageCount = currentExchanges.reduce(
      (max, exchange) => Math.max(max, exchange.messageCount),
      0
    );
    const outboundMessageCount = calls
      .slice(beforeCallCount)
      .filter(call => call.kind === 'message' || call.kind === 'group-message').length;
    if (receiveCount >= scenario.expectedReceiveCount) {
      const chatMatched = !scenario.expectedChatMessageCount || maxBufferedMessageCount >= scenario.expectedChatMessageCount;
      const outboundMatched =
        !scenario.expectedOutboundMessageCount || outboundMessageCount >= scenario.expectedOutboundMessageCount;
      if (chatMatched && outboundMatched) {
        return { matched: true, skipped: false };
      }
      const lastExchangeAt = currentExchanges.at(-1)?.at;
      if (
        lastExchangeAt &&
        (currentExchanges.length >= scenario.expectedReceiveCount || Date.now() - Date.parse(lastExchangeAt) > 3000)
      ) {
        return { matched: false, skipped: false };
      }
    }
    if (Date.now() - startedAt > 120000 && receiveCount > 0) {
      return { matched: false, skipped: false };
    }
    await delay(500);
  }

  return { matched: false, skipped: false };
}

function scenarioForBufferedRequest(
  request: ChatEndpointRequest,
  scenariosByHandle: Map<string, { id: string; title: string }>
): string | undefined {
  const handles = readRequestMessageHandles(request);
  const counts = new Map<string, number>();
  for (const handle of handles) {
    const scenario = scenariosByHandle.get(handle);
    if (scenario) counts.set(scenario.id, (counts.get(scenario.id) ?? 0) + 1);
  }
  let selected: { id: string; count: number; firstIndex: number } | undefined;
  for (const [id, count] of counts) {
    const firstIndex = handles.findIndex(handle => scenariosByHandle.get(handle)?.id === id);
    if (!selected || count > selected.count || (count === selected.count && firstIndex < selected.firstIndex)) {
      selected = { id, count, firstIndex };
    }
  }
  return selected?.id;
}

function readRequestMessageHandles(request: ChatEndpointRequest): string[] {
  const handles = Array.isArray(request.messages)
    ? request.messages.map(message => message.messageHandle).filter(Boolean)
    : [];
  if (request.messageHandle) handles.push(request.messageHandle);
  return [...new Set(handles)];
}

async function waitForQuietStep(
  envelopes: ShowcaseCaptureEnvelope[],
  calls: Array<{ at: string }>,
  exchanges: Array<{ at: string }>,
  options: {
    beforeEnvelopeCount: number;
    beforeCallCount: number;
    beforeExchangeCount: number;
    quietMs: number;
    maxMs: number;
  }
): Promise<void> {
  const startedAt = Date.now();
  let lastEnvelopeCount = envelopes.length;
  let lastCallCount = calls.length;
  let lastExchangeCount = exchanges.length;
  let lastChangedAt = Date.now();

  while (!shuttingDown && Date.now() - startedAt < options.maxMs) {
    const envelopeCount = envelopes.length;
    const callCount = calls.length;
    const exchangeCount = exchanges.length;
    if (envelopeCount !== lastEnvelopeCount || callCount !== lastCallCount || exchangeCount !== lastExchangeCount) {
      lastEnvelopeCount = envelopeCount;
      lastCallCount = callCount;
      lastExchangeCount = exchangeCount;
      lastChangedAt = Date.now();
    }

    const hasStepActivity =
      envelopeCount > options.beforeEnvelopeCount ||
      callCount > options.beforeCallCount ||
      exchangeCount > options.beforeExchangeCount;
    if (hasStepActivity && Date.now() - lastChangedAt >= options.quietMs) return;
    await delay(500);
  }
}

function hasSkipReply(envelopes: ShowcaseCaptureEnvelope[]): boolean {
  return envelopes.some(envelope => envelope.path === '/webhook/receive' && isSkipContent(readEnvelopeContent(envelope)));
}

function readEnvelopeContent(envelope: ShowcaseCaptureEnvelope): string | undefined {
  const body = envelope.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const content = (body as Record<string, unknown>).content;
  return typeof content === 'string' ? content : undefined;
}

function readEnvelopeMessageHandle(envelope: { body: unknown }): string | undefined {
  const body = envelope.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const handle = (body as Record<string, unknown>).message_handle;
  return typeof handle === 'string' && handle.trim() ? handle : undefined;
}

function readShowcaseMediaUrl(envValues: Record<string, string | undefined>): string | undefined {
  const direct = envValues.SHOWCASE_MEDIA_URL || envValues.HOSTED_MEDIA_URL;
  if (direct) return direct;
  const base = envValues.HOSTED_MEDIA_BASE_URL?.replace(/\/+$/, '');
  return base ? `${base}/demo-image.png` : undefined;
}

async function tryRegisterTypingIndicatorWebhook(
  envValues: typeof env,
  rawEnvValues: Record<string, string | undefined>,
  publicBaseUrl: string
): Promise<{
  type: 'typing_indicator';
  url: string;
  persisted: boolean;
  message: string;
  attempts: Array<{ baseUrl: string; method: 'POST' | 'PUT'; status: number; ok: boolean; message?: string }>;
}> {
  const url = `${publicBaseUrl.replace(/\/+$/, '')}/webhook/typing-indicator`;
  const bases = [
    envValues.sendblueApiBaseUrl,
    rawEnvValues.SENDBLUE_API_V2_BASE_URL || 'https://api.sendblue.com'
  ]
    .map(value => value.replace(/\/+$/, ''))
    .filter((value, index, values) => values.indexOf(value) === index);
  const attempts: Array<{ baseUrl: string; method: 'POST' | 'PUT'; status: number; ok: boolean; message?: string }> = [];

  for (const baseUrl of bases) {
    const post = await fetch(`${baseUrl}/api/account/webhooks`, {
      method: 'POST',
      headers: webhookHeaders(envValues),
      body: JSON.stringify({
        type: 'typing_indicator',
        webhooks: [webhookValue(url, envValues.sendblueWebhookSecret)]
      })
    });
    const postBody = await post.json().catch(() => null);
    attempts.push({
      baseUrl,
      method: 'POST',
      status: post.status,
      ok: post.ok,
      message: readResponseMessage(postBody)
    });
    if (post.ok && (await hasTypingWebhook(baseUrl, envValues, url))) {
      return { type: 'typing_indicator', url, persisted: true, message: 'registered with POST', attempts };
    }

    const current = await fetch(`${baseUrl}/api/account/webhooks`, {
      headers: webhookAuthHeaders(envValues)
    }).then(response => response.json().catch(() => null));
    const currentRecord = isRecord(current) ? current : {};
    const currentWebhooks = isRecord(currentRecord.webhooks) ? currentRecord.webhooks : {};
    const config: Record<string, unknown> = { ...currentWebhooks };
    config.typing_indicator = [webhookValue(url, envValues.sendblueWebhookSecret)];

    const put = await fetch(`${baseUrl}/api/account/webhooks`, {
      method: 'PUT',
      headers: webhookHeaders(envValues),
      body: JSON.stringify({ webhooks: config })
    });
    const putBody = await put.json().catch(() => null);
    attempts.push({
      baseUrl,
      method: 'PUT',
      status: put.status,
      ok: put.ok,
      message: readResponseMessage(putBody)
    });
    if (put.ok && (await hasTypingWebhook(baseUrl, envValues, url))) {
      return { type: 'typing_indicator', url, persisted: true, message: 'registered with full webhooks PUT', attempts };
    }
  }

  return {
    type: 'typing_indicator',
    url,
    persisted: false,
    message:
      'Sendblue docs list typing_indicator, but the live account webhooks API rejected POST registration and did not persist it through PUT.',
    attempts
  };
}

async function hasTypingWebhook(baseUrl: string, envValues: typeof env, url: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/api/account/webhooks`, {
    headers: webhookAuthHeaders(envValues)
  });
  const body = await response.json().catch(() => null);
  const bodyRecord = isRecord(body) ? body : {};
  const webhooks = isRecord(bodyRecord.webhooks) ? bodyRecord.webhooks : {};
  const typing = webhooks.typing_indicator;
  return Array.isArray(typing) && typing.some(value => webhookUrl(value) === url);
}

function webhookValue(url: string, secret: string | undefined): string | { url: string; secret: string } {
  return secret ? { url, secret } : url;
}

function webhookUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).url === 'string') {
    return (value as { url: string }).url;
  }
  return undefined;
}

function webhookAuthHeaders(envValues: typeof env): Record<string, string> {
  return {
    'sb-api-key-id': envValues.sendblueApiKeyId ?? '',
    'sb-api-secret-key': envValues.sendblueApiSecretKey ?? ''
  };
}

function webhookHeaders(envValues: typeof env): Record<string, string> {
  return {
    ...webhookAuthHeaders(envValues),
    'content-type': 'application/json'
  };
}

function readResponseMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const record = body;
  return typeof record.message === 'string'
    ? record.message
    : typeof record.error_message === 'string'
      ? record.error_message
      : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function writeSummary(outputDirPath: string, summary: unknown): Promise<void> {
  await mkdir(outputDirPath, { recursive: true });
  await writeFile(resolve(outputDirPath, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}

async function listen(app: import('express').Express, port: number): Promise<Server> {
  return new Promise((resolveListen, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolveListen(server));
    server.on('error', reject);
  });
}

async function shutdown(): Promise<void> {
  activeScenario = undefined;
  if (agentServer) await new Promise<void>(resolveClose => agentServer!.close(() => resolveClose()));
  await agent.close();
  await chat.close();
  if (ngrok) await ngrok.close();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
