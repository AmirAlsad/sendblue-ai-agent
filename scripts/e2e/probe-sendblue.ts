#!/usr/bin/env -S node --import tsx
// Diagnostic probe for /api/mark-read.
//
// Reports whether the read-receipt endpoint succeeds for the configured
// Sendblue line + E2E_TEST_DEVICE_NUMBER. Useful after support enables the
// account-gated read-receipts feature
// (https://docs.sendblue.com/api-v2/read-receipts).
//
// Side effects: a successful call sends an iMessage "read receipt" to the
// recipient's device (UI-visible "Read 3:47 PM"). No outbound message is
// sent, no webhook config is mutated.

import 'dotenv/config';
import { loadConfig } from '../../src/config/env.js';
import { HttpSendblueClient, SendblueApiError } from '../../src/sendblue/client.js';

const env = process.env;
const config = loadConfig(env);
const toNumber = env.E2E_TEST_DEVICE_NUMBER;

if (!toNumber) {
  console.error('E2E_TEST_DEVICE_NUMBER required in .env');
  process.exit(1);
}

console.log('=== mark-read ===');
console.log(`POST ${config.sendblueApiV2BaseUrl}/api/mark-read  to: ${toNumber}`);
const client = new HttpSendblueClient(config);
try {
  const result = await client.markRead({ toNumber: toNumber! });
  console.log('SUCCESS');
  console.log(`  result: ${JSON.stringify(result, null, 2)}`);
} catch (error) {
  console.log('FAILED');
  if (error instanceof SendblueApiError) {
    console.log(`  operation: ${error.operation}`);
    console.log(`  httpStatus: ${error.httpStatus}`);
    console.log(`  errorCode: ${error.errorCode ?? '(none)'}`);
    console.log(`  serverMessage: ${error.serverMessage ?? '(none)'}`);
    console.log(`  responseBody: ${JSON.stringify(error.responseBody)}`);
  } else {
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}
