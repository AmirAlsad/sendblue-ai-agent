import pino from 'pino';
import { createApp } from '../../src/http/app.js';
import { HttpChatClient } from '../../src/chat/client.js';
import { HttpSendblueClient } from '../../src/sendblue/client.js';
import { InMemoryStatusStore } from '../../src/status/tracker.js';
import { assertEnv, mergeRuntimeEnv, readSetupEnv } from './lib/env.js';
import { checkNgrokCommand, startNgrok, waitForNgrokPublicUrl } from './lib/ngrok.js';
import { SendblueWebhookClient } from './lib/sendblue-webhooks.js';
import { startDeterministicChatEndpoint } from './lib/local-servers.js';

const env = readSetupEnv();
assertEnv(env, 'dev');

const ngrokCheck = checkNgrokCommand(env.ngrokBin);
if (!ngrokCheck.ok) {
  throw new Error(`ngrok CLI check failed: ${ngrokCheck.error}`);
}

const chat = await startDeterministicChatEndpoint();
const ngrok = startNgrok(env);
ngrok.stdout?.on('data', chunk => process.stdout.write(`[ngrok] ${chunk}`));
ngrok.stderr?.on('data', chunk => process.stderr.write(`[ngrok] ${chunk}`));

const publicBaseUrl = await waitForNgrokPublicUrl(env.ngrokApiUrl);
const runtimeEnv = mergeRuntimeEnv(env, publicBaseUrl, chat.url);
const config = {
  port: env.agentPort,
  publicBaseUrl,
  chatEndpointUrl: chat.url,
  chatEndpointTimeoutMs: 10000,
  sendblueApiBaseUrl: env.sendblueApiBaseUrl,
  sendblueApiKeyId: env.sendblueApiKeyId!,
  sendblueApiSecretKey: env.sendblueApiSecretKey!,
  sendblueFromNumber: env.sendblueFromNumber!,
  sendblueWebhookSecret: env.sendblueWebhookSecret,
  sendblueWebhookSecretHeader: env.sendblueWebhookSecretHeader
};

Object.assign(process.env, runtimeEnv);

const { app } = createApp({
  config,
  chatClient: new HttpChatClient(config),
  sendblueClient: new HttpSendblueClient(config),
  statusStore: new InMemoryStatusStore(),
  logger: pino({ level: process.env.LOG_LEVEL || 'info' })
});

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
  ngrok.kill('SIGTERM');
  await closeAgent();
  await chat.close();
}

async function closeAgent() {
  await new Promise<void>(resolve => agentServer.close(() => resolve()));
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
