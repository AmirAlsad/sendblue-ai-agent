import { randomUUID } from 'node:crypto';
import { assertEnv, readSetupEnv } from './lib/env.js';
import {
  startSendblueCaptureServer,
  type CapturedWebhookEnvelope,
  type StartedCaptureServer
} from './lib/capture-server.js';
import {
  formatCapturePrompt,
  guidedCaptureScenarios,
  sendCapturePrompt,
  type GuidedCaptureScenario
} from './lib/guided-capture.js';
import { startNgrokTunnel, type StartedNgrokTunnel } from './lib/ngrok.js';
import { SendblueWebhookClient } from './lib/sendblue-webhooks.js';
import { CAPTURE_MANAGED_WEBHOOK_TYPES } from '../../src/sendblue/webhook-types.js';

const DEFAULT_SETTLE_MS = 5000;

const selectedScenarios = selectScenarios(process.argv.slice(2));
const env = readSetupEnv();
assertEnv(env, 'capture');

const sessionId = randomUUID().slice(0, 8);
let activeScenario: { id: string; title: string } | undefined;
let ngrok: StartedNgrokTunnel | undefined;
let shuttingDown = false;

const capture = await startSendblueCaptureServer({
  port: env.agentPort,
  metadata: () => ({
    sessionId,
    scenarioId: activeScenario?.id,
    scenarioTitle: activeScenario?.title
  }),
  onCapture: envelope => {
    const scenario = typeof envelope.capture?.scenarioId === 'string' ? envelope.capture.scenarioId : 'unassigned';
    console.log(`  webhook captured: ${envelope.path} (${scenario})`);
  }
});

const publicBaseUrl = env.e2ePublicBaseUrl ?? (ngrok = await startNgrokTunnel(env)).publicUrl;
const webhookResults = await new SendblueWebhookClient(env).apply(publicBaseUrl, {
  types: CAPTURE_MANAGED_WEBHOOK_TYPES
});

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

console.log('\nGuided Sendblue capture is running.');
console.log(`Session: ${sessionId}`);
console.log(`Capture server: ${capture.url}`);
console.log(`Public URL: ${publicBaseUrl}`);
console.log(`Writing raw captures to: ${capture.outputDir}`);
for (const result of webhookResults) {
  console.log(`Sendblue ${result.type}: ${result.action} ${result.url}`);
}
console.log('\nEach step sends an instruction to E2E_TEST_DEVICE_NUMBER.');
console.log('Complete the requested action on your device. The script advances after the expected webhook arrives.');
console.log('To skip a step, reply "skip" to the current instruction.');
console.log('All Sendblue webhook types are registered during capture so operational callbacks are saved too.');
console.log('Use Ctrl+C to stop early. Raw captures may contain secrets, phone numbers, and message content.\n');

try {
  for (const [index, scenario] of selectedScenarios.entries()) {
    if (shuttingDown) break;

    activeScenario = { id: scenario.id, title: scenario.title };
    const beforeCount = capture.envelopes.length;
    const prompt = formatCapturePrompt({
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
    console.log(`Expected webhook: ${scenario.expectedWebhook}`);
    console.log('Waiting for the expected webhook or a skip reply...');

    const result = await waitForScenario(capture, scenario, beforeCount);
    const captured = capture.envelopes.slice(beforeCount);
    const receiveCount = captured.filter(envelope => envelope.path === '/webhook/receive').length;
    const statusCount = captured.filter(envelope => envelope.path === '/webhook/status').length;
    const marker = result.skipped ? 'skipped' : 'matched';
    console.log(`Step ${marker}: ${receiveCount} receive, ${statusCount} status captured.`);
  }

  console.log('\nGuided capture complete.');
  console.log(`Captured ${capture.envelopes.length} total webhook envelopes in ${capture.outputDir}.`);
  console.log('Redact captures before moving stable examples into tests/fixtures/sendblue/captured/.');
} finally {
  await shutdown();
}

async function waitForScenario(
  server: StartedCaptureServer,
  scenario: GuidedCaptureScenario,
  beforeCount: number
): Promise<{ matched: boolean; skipped: boolean }> {
  while (!shuttingDown) {
    const envelopes = server.envelopes.slice(beforeCount);
    if (hasSkipReply(envelopes, scenario)) {
      await delay(scenario.settleMs ?? DEFAULT_SETTLE_MS);
      return { matched: false, skipped: true };
    }

    if (hasExpectedWebhook(envelopes, scenario)) {
      await delay(scenario.settleMs ?? DEFAULT_SETTLE_MS);
      return { matched: true, skipped: false };
    }

    await delay(500);
  }

  return { matched: false, skipped: false };
}

function hasExpectedWebhook(envelopes: CapturedWebhookEnvelope[], scenario: GuidedCaptureScenario): boolean {
  const matchesScenario = envelopes.filter(envelope => envelope.capture?.scenarioId === scenario.id);
  if (scenario.expectedWebhook === 'receive') {
    return matchesScenario.some(envelope => envelope.path === '/webhook/receive');
  }
  if (scenario.expectedWebhook === 'status') {
    return matchesScenario.some(envelope => envelope.path === '/webhook/status');
  }
  return (
    matchesScenario.some(envelope => envelope.path === '/webhook/receive') &&
    matchesScenario.some(envelope => envelope.path === '/webhook/status')
  );
}

function hasSkipReply(envelopes: CapturedWebhookEnvelope[], scenario: GuidedCaptureScenario): boolean {
  return envelopes.some(
    envelope =>
      envelope.capture?.scenarioId === scenario.id &&
      envelope.path === '/webhook/receive' &&
      isSkipContent(readEnvelopeContent(envelope))
  );
}

function readEnvelopeContent(envelope: CapturedWebhookEnvelope): string | undefined {
  const body = envelope.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const content = (body as Record<string, unknown>).content;
  return typeof content === 'string' ? content : undefined;
}

function isSkipContent(content: string | undefined): boolean {
  return /^\s*(skip|skip this|skip step|next)\s*$/i.test(content ?? '');
}

function selectScenarios(args: string[]): GuidedCaptureScenario[] {
  if (args.includes('--list')) {
    console.log('Available guided capture scenarios:');
    for (const scenario of guidedCaptureScenarios) {
      const optional = scenario.optional ? ' (optional)' : '';
      console.log(`- ${scenario.id}${optional}: ${scenario.title}`);
    }
    process.exit(0);
  }

  const only = readArg(args, '--only');
  if (!only) return guidedCaptureScenarios;

  const ids = only
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error('No guided capture scenarios selected.');
  }

  const byId = new Map(guidedCaptureScenarios.map(scenario => [scenario.id, scenario]));
  const unknown = ids.filter(id => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown guided capture scenario(s): ${unknown.join(', ')}. Run npm run capture:guided -- --list to see available scenarios.`
    );
  }

  return ids.map(id => byId.get(id)!);
}

function readArg(args: string[], name: string): string | undefined {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function shutdown(): Promise<void> {
  activeScenario = undefined;
  await capture.close();
  if (ngrok) await ngrok.close();
}
