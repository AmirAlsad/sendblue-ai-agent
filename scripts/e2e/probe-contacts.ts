#!/usr/bin/env -S node --import tsx
// Diagnostic probe for /api/v2/contacts.
//
// Confirms that Sendblue accepts the body shape `HttpSendblueClient.createContact`
// emits (snake_case keys, `update_if_exists: true`) and reports the response.
// After the create call, a follow-up DELETE attempts to clean up the test
// contact so the operator's Sendblue dashboard stays uncluttered.
//
// Side effects: creates (or upserts) a Sendblue contact for E2E_TEST_DEVICE_NUMBER
// with first_name "Probe" and last_name "Test", then attempts to delete it.
// No message is sent and no webhook config is mutated.

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

const client = new HttpSendblueClient(config);

console.log('=== create-contact ===');
console.log(`POST ${config.sendblueApiV2BaseUrl}/api/v2/contacts  number: ${toNumber}`);
let createOk = false;
try {
  const result = await client.createContact({
    number: toNumber,
    firstName: 'Probe',
    lastName: 'Test',
    sendblueNumber: config.sendblueFromNumber,
    tags: ['probe', 'auto-delete'],
    customVariables: { source: 'sendblue-ai-agent probe' },
    updateIfExists: true
  });
  createOk = true;
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

// Cleanup: best-effort DELETE so the probe does not leave a test contact in
// the Sendblue dashboard. Sendblue documents DELETE /api/v2/contacts/{phone}
// at https://docs.sendblue.com/api-v2/contacts/. We use a raw fetch because
// `SendblueClient` does not expose deleteContact today (out of scope per
// docs/features/outbound-client.md).
console.log('\n=== cleanup: delete-contact ===');
const deleteUrl = `${config.sendblueApiV2BaseUrl}/api/v2/contacts/${encodeURIComponent(toNumber)}`;
console.log(`DELETE ${deleteUrl}`);
try {
  const response = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: {
      'sb-api-key-id': config.sendblueApiKeyId,
      'sb-api-secret-key': config.sendblueApiSecretKey
    }
  });
  const body = await response.text();
  if (response.ok) {
    console.log(`SUCCESS (${response.status})`);
    if (body) console.log(`  responseBody: ${body}`);
  } else {
    console.log(`FAILED (${response.status})`);
    console.log(`  responseBody: ${body}`);
    if (createOk) {
      console.log(
        '  note: contact was created. Manually delete it from the Sendblue dashboard,'
      );
      console.log(
        '  or contact support@sendblue.com if DELETE /api/v2/contacts is not available on your plan.'
      );
    }
  }
} catch (error) {
  console.log('FAILED');
  console.log(`  ${error instanceof Error ? error.message : String(error)}`);
}
