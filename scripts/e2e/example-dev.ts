/**
 * `npm run example:dev -- <example-name>`
 *
 * Hardware-loop runner: boots the chosen example as the chat endpoint,
 * the agent pointing at it, ngrok, and Sendblue webhooks. Same shape as
 * `npm run dev:e2e`, but the chat endpoint is one of the bots from
 * `examples/` instead of the built-in deterministic endpoint.
 *
 * Once running, message your Sendblue line from `E2E_TEST_DEVICE_NUMBER`
 * (or any device) — the example handles the conversation.
 */
import 'dotenv/config';
import pino from 'pino';
import { createApp } from '../../src/http/app.js';
import { HttpChatClient } from '../../src/chat/client.js';
import { HttpSendblueClient } from '../../src/sendblue/client.js';
import { InMemoryStatusStore } from '../../src/status/tracker.js';
import { loadConfig } from '../../src/config/env.js';
import { assertEnv, mergeRuntimeEnv, readSetupEnv } from './lib/env.js';
import { startNgrokTunnel } from './lib/ngrok.js';
import { SendblueWebhookClient } from './lib/sendblue-webhooks.js';
import {
  EXAMPLES,
  checkRequiredEnv,
  ensureInstalled,
  exampleNames,
  killChildAndWait,
  spawnExample,
  waitForHealth
} from '../lib/examples.js';

function parseArgs(argv: string[]): { example?: string; help: boolean } {
  const out: { example?: string; help: boolean } = { help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (!arg.startsWith('-') && !out.example) out.example = arg;
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage: npm run example:dev -- <example-name>

Boots the chosen example as the chat endpoint, the agent pointing at it,
ngrok, and Sendblue webhooks. Real iMessage to your Sendblue line will
flow through the example.

Available examples:
${Object.values(EXAMPLES)
  .map(e => `  ${e.name.padEnd(24)} ${e.description}`)
  .join('\n')}

Required env (set in .env at the repo root):
  SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER
  NGROK_AUTHTOKEN
  E2E_TEST_DEVICE_NUMBER  (the phone you'll text from — used for the printed instructions)

Some examples need their own env (e.g. showcase-bot needs ANTHROPIC_API_KEY
in examples/showcase-bot/.env).
`);
}

const args = parseArgs(process.argv);
if (args.help || !args.example) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const spec = EXAMPLES[args.example];
if (!spec) {
  console.error(`unknown example: ${args.example}`);
  console.error(`available: ${exampleNames().join(', ')}`);
  process.exit(1);
}

const missingExampleEnv = checkRequiredEnv(spec);
if (missingExampleEnv.length > 0) {
  console.error(`missing required env for ${spec.name}: ${missingExampleEnv.join(', ')}`);
  console.error(`set them in ${spec.dir}/.env or your shell. see ${spec.dir}/.env.example`);
  process.exit(1);
}

const env = readSetupEnv();
assertEnv(env, 'dev');

if (spec.needsInstall) {
  await ensureInstalled(spec);
}

const exampleChild = spawnExample(spec);
const exampleUrl = `http://127.0.0.1:${spec.port}/chat`;

try {
  await waitForHealth(spec.port);
} catch (err) {
  console.error((err as Error).message);
  await killChildAndWait(exampleChild);
  process.exit(1);
}

const ngrok = await startNgrokTunnel(env);
const publicBaseUrl = ngrok.publicUrl;
const runtimeEnv = mergeRuntimeEnv(env, publicBaseUrl, exampleUrl);

Object.assign(process.env, runtimeEnv);
const config = loadConfig({
  ...process.env,
  PORT: String(env.agentPort),
  PUBLIC_BASE_URL: publicBaseUrl,
  CHAT_ENDPOINT_URL: exampleUrl,
  CHAT_ENDPOINT_TIMEOUT_MS: '30000',
  SENDBLUE_API_BASE_URL: env.sendblueApiBaseUrl,
  SENDBLUE_API_KEY_ID: env.sendblueApiKeyId!,
  SENDBLUE_API_SECRET_KEY: env.sendblueApiSecretKey!,
  SENDBLUE_FROM_NUMBER: env.sendblueFromNumber!,
  SENDBLUE_WEBHOOK_SECRET: env.sendblueWebhookSecret,
  SENDBLUE_WEBHOOK_SECRET_HEADER: env.sendblueWebhookSecretHeader
});

const agent = createApp({
  config,
  chatClient: new HttpChatClient(config),
  sendblueClient: new HttpSendblueClient(config),
  statusStore: new InMemoryStatusStore(),
  logger: pino({ level: process.env.LOG_LEVEL || 'info' })
});
const { app } = agent;

const agentServer = await new Promise<import('node:http').Server>((resolve, reject) => {
  const server = app.listen(env.agentPort, '127.0.0.1', () => resolve(server));
  server.on('error', reject);
});

const webhookResults = await new SendblueWebhookClient(env).apply(publicBaseUrl);

console.log('');
console.log(`▶ example:dev — ${spec.name}`);
console.log(`  Agent:           http://127.0.0.1:${env.agentPort}`);
console.log(`  Public URL:      ${publicBaseUrl}`);
console.log(`  Example endpoint: ${exampleUrl}`);
console.log(`  Sendblue line:   ${env.sendblueFromNumber}`);
if (env.testDeviceNumber) {
  console.log(`  Your device:     ${env.testDeviceNumber}`);
}
for (const result of webhookResults) {
  console.log(`  Sendblue ${result.type.padEnd(18)} ${result.action} ${result.url}`);
}
console.log('');
console.log(`  Send an iMessage from ${env.testDeviceNumber || 'any device'} to ${env.sendblueFromNumber}.`);
if (spec.hints) for (const hint of spec.hints) console.log(`  • ${hint}`);
console.log('');
console.log('  Press Ctrl+C to stop. Webhooks stay registered with Sendblue between runs — re-run to refresh them.');

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nshutting down...');
  try {
    await ngrok.close();
  } catch (err) {
    console.error('ngrok close failed:', err);
  }
  try {
    await new Promise<void>(resolve => agentServer.close(() => resolve()));
    await agent.close();
  } catch (err) {
    console.error('agent close failed:', err);
  }
  await killChildAndWait(exampleChild);
}

process.once('SIGINT', () => {
  shutdown()
    .catch(error => console.error(error))
    .finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  shutdown()
    .catch(error => console.error(error))
    .finally(() => process.exit(0));
});

exampleChild.on('exit', code => {
  if (!shuttingDown) {
    console.error(`example process exited with code ${code} — shutting down`);
    void shutdown().finally(() => process.exit(code ?? 1));
  }
});
