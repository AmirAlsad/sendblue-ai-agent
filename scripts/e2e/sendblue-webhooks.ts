import { assertEnv, readSetupEnv } from './lib/env.js';
import { SendblueWebhookClient } from './lib/sendblue-webhooks.js';

const env = readSetupEnv();
assertEnv(env, 'sendblue-webhooks');

const results = await new SendblueWebhookClient(env).apply(env.publicBaseUrl!);
for (const result of results) {
  console.log(`${result.type}: ${result.action} ${result.url}`);
}
