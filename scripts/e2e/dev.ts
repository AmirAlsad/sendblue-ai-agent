import pino from 'pino';
import { createApp } from '../../src/http/app.js';
import { HttpChatClient } from '../../src/chat/client.js';
import { HttpSendblueClient } from '../../src/sendblue/client.js';
import { InMemoryStatusStore } from '../../src/status/tracker.js';
import { loadConfig } from '../../src/config/env.js';
import { assertEnv, mergeRuntimeEnv, readSetupEnv } from './lib/env.js';
import { startNgrokTunnel } from './lib/ngrok.js';
import { SendblueWebhookClient } from './lib/sendblue-webhooks.js';
import { startDeterministicChatEndpoint } from './lib/local-servers.js';

const env = readSetupEnv();
assertEnv(env, 'dev');

const chat = await startDeterministicChatEndpoint();
const ngrok = await startNgrokTunnel(env);
const publicBaseUrl = ngrok.publicUrl;
const runtimeEnv = mergeRuntimeEnv(env, publicBaseUrl, chat.url);

Object.assign(process.env, runtimeEnv);
const config = loadConfig({
  ...process.env,
  PORT: String(env.agentPort),
  PUBLIC_BASE_URL: publicBaseUrl,
  CHAT_ENDPOINT_URL: chat.url,
  CHAT_ENDPOINT_TIMEOUT_MS: '10000',
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

console.log('\nE2E dev stack is running.');
console.log(`Agent: http://127.0.0.1:${env.agentPort}`);
console.log(`Public URL: ${publicBaseUrl}`);
console.log(`Chat endpoint: ${chat.url}`);
for (const result of webhookResults) {
  console.log(`Sendblue ${result.type}: ${result.action} ${result.url}`);
}
console.log('\nPress Ctrl+C to stop.');

async function shutdown() {
  await ngrok.close();
  await closeAgent();
  await chat.close();
}

async function closeAgent() {
  await new Promise<void>(resolve => agentServer.close(() => resolve()));
  await agent.close();
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
