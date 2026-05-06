import { assertEnv, readSetupEnv } from './lib/env.js';
import { checkNativeMessagesPrerequisites, resolveMessagesDbPath } from './lib/messages.js';
import { checkNgrokCommand } from './lib/ngrok.js';
import { SendblueWebhookClient } from './lib/sendblue-webhooks.js';

const env = readSetupEnv();
assertEnv(env, 'verify');

let failed = false;

const ngrok = checkNgrokCommand(env.ngrokBin);
if (ngrok.ok) {
  console.log(`ngrok CLI found: ${env.ngrokBin}`);
} else {
  failed = true;
  console.error(`ngrok CLI check failed: ${ngrok.error}`);
}

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
