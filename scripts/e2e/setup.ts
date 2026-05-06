import { ensureEnvFile, missingEnv, readSetupEnv } from './lib/env.js';

const result = ensureEnvFile();
const env = readSetupEnv();
const missing = missingEnv(env, 'verify');

console.log(result.created ? `Created ${result.path}` : `Found ${result.path}`);

if (missing.length > 0) {
  console.log('\nFill these values before running real-device E2E:');
  for (const name of missing) console.log(`- ${name}`);
} else {
  console.log('\nE2E environment has the required values for verification.');
}

console.log('\nOne-time Mac setup still required outside Node:');
console.log('- Messages.app signed into iMessage');
console.log('- Terminal or the test runner granted Full Disk Access for ~/Library/Messages/chat.db');
console.log('- macOS Automation permission granted when osascript first controls Messages.app');
console.log('- ngrok installed or NGROK_BIN pointed at the ngrok executable');
