import { readSetupEnv } from './lib/env.js';
import { startSendblueCaptureServer } from './lib/capture-server.js';

const env = readSetupEnv();
const server = await startSendblueCaptureServer({ port: env.agentPort });

console.log('Sendblue fixture capture server is running.');
console.log(`Receive URL: ${server.url}/webhook/receive`);
console.log(`Status URL: ${server.url}/webhook/status`);
console.log(`Writing raw captures to: ${server.outputDir}`);
console.log('\nBefore committing a capture, redact phone numbers, message content, secrets, and tunnel URLs.');
console.log('Move stable redacted envelopes into tests/fixtures/sendblue/captured/.');
console.log('\nPress Ctrl+C to stop.');

async function shutdown() {
  await server.close();
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
