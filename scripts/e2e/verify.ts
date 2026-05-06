import { assertEnv, readSetupEnv } from './lib/env.js';
import { checkNativeMessagesPrerequisites, resolveMessagesDbPath } from './lib/messages.js';
import { SendblueWebhookClient } from './lib/sendblue-webhooks.js';

const env = readSetupEnv();
assertEnv(env, 'verify');

let failed = false;

console.log('ok - ngrok auth token configured');

const nativeMessages = await checkNativeMessagesPrerequisites(resolveMessagesDbPath(env.messagesDbPath));
for (const check of nativeMessages.checks) {
  const detail = check.detail ? `: ${check.detail}` : '';
  console.log(`${check.ok ? 'ok' : 'failed'} - ${check.name}${detail}`);
}
if (!nativeMessages.ok) {
  failed = true;
}

try {
  const webhooks = await new SendblueWebhookClient(env).list();
  console.log(`Sendblue webhook API reachable: ${webhooks.length} webhook(s) visible`);
} catch (error) {
  failed = true;
  console.error(`Sendblue webhook API check failed: ${error instanceof Error ? error.message : error}`);
}

if (failed) process.exitCode = 1;
