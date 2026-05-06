import { assertEnv, readSetupEnv } from './lib/env.js';
import { SendblueWebhookClient } from './lib/sendblue-webhooks.js';
import {
  CAPTURE_MANAGED_WEBHOOK_TYPES,
  DEFAULT_MANAGED_WEBHOOK_TYPES
} from '../../src/sendblue/webhook-types.js';

const env = readSetupEnv();
assertEnv(env, 'sendblue-webhooks');
const allTypes = process.argv.includes('--all');
const types = allTypes ? CAPTURE_MANAGED_WEBHOOK_TYPES : DEFAULT_MANAGED_WEBHOOK_TYPES;

const results = await new SendblueWebhookClient(env).apply(env.publicBaseUrl!, { types });
for (const result of results) {
  console.log(`${result.type}: ${result.action} ${result.url}`);
}
