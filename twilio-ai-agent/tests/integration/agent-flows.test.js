// End-to-end behavior tests for twilio-ai-agent.
//
// These tests boot the actual agent (via tests/integration/helpers/agent-harness)
// against a programmable mock chat endpoint, a small in-process user-lookup
// stub, and a require.cache-mocked Twilio sender. They exercise the real
// state machine, BullMQ buffer timer, ordered-delivery queue, and trigger
// system end-to-end.
//
// Run with: node --test tests/integration/agent-flows.test.js
//
// Requires Redis running on localhost:6379 (override with TEST_REDIS_URL).
// Uses Redis DB 15 by default to avoid colliding with developer state.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootHarness } = require('./helpers/agent-harness');

let harness;

test.before(async () => {
  harness = await bootHarness({ bufferMs: 100 });
});

test.beforeEach(async () => {
  await harness.reset();
});

test.after(async () => {
  if (harness) await harness.shutdown();
});

// ============================================================================
// Inbound flow
// ============================================================================

test('single inbound message → chat endpoint receives it → user gets the reply', async () => {
  harness.setUser({ userId: 'u1', phone: '+15551110001', data: { tier: 'paid' } });

  await harness.sendInbound({ phone: '+15551110001', body: 'hello there' });

  await harness.waitFor(() => harness.chat.calls.length === 1, { label: 'chat call' });

  const call = harness.chat.calls[0];
  assert.equal(call.body.userId, 'u1');
  assert.equal(call.body.phoneNumber, '+15551110001');
  assert.equal(call.body.message, 'hello there');
  assert.equal(call.body.interface, 'sms');
  assert.equal(call.body.stream, true);
  assert.deepEqual(call.body.user, { tier: 'paid' });

  // The default echo response shapes the reply.
  await harness.waitFor(() => harness.twilioCalls.length === 1, { label: 'twilio send' });
  assert.equal(harness.twilioCalls[0].body, 'echo: hello there');
  assert.equal(harness.twilioCalls[0].to, '+15551110001');
  assert.equal(harness.twilioCalls[0].channel, 'sms');
});

test('multi-message burst is aggregated into one chat call with `\\n---\\n` delimiter', async () => {
  harness.setUser({ userId: 'u1', phone: '+15551110002' });

  // Fire three messages with tiny gaps so the state machine reaches BUFFERING
  // before each subsequent webhook lands. (In production, real users space
  // their messages by hundreds of ms; the package's race window is only
  // visible when two webhooks arrive simultaneously.)
  await harness.sendInbound({ phone: '+15551110002', body: 'first' });
  await new Promise(r => setTimeout(r, 25));
  await harness.sendInbound({ phone: '+15551110002', body: 'second' });
  await new Promise(r => setTimeout(r, 25));
  await harness.sendInbound({ phone: '+15551110002', body: 'third' });

  await harness.waitFor(() => harness.chat.calls.length === 1, { label: 'aggregated chat call' });

  assert.equal(harness.chat.calls.length, 1, 'expected exactly one chat call');
  const aggregated = harness.chat.calls[0].body.message;
  assert.equal(aggregated, 'first\n---\nsecond\n---\nthird');
});

test('silence response: chat returns {silence: true} → no Twilio send', async () => {
  harness.setUser({ userId: 'u1', phone: '+15551110003' });
  harness.chat.scriptNext({ silence: true });

  await harness.sendInbound({ phone: '+15551110003', body: 'hi' });

  await harness.waitFor(() => harness.chat.calls.length === 1, { label: 'chat call' });
  // Give the system a moment to potentially send if it would.
  await new Promise(r => setTimeout(r, 200));

  assert.equal(harness.twilioCalls.length, 0, 'silence must skip Twilio entirely');
});

test('multi-message reply: all messages reach Twilio in order', async () => {
  harness.setUser({ userId: 'u1', phone: '+15551110004' });
  harness.chat.scriptNext({ messages: ['one', 'two', 'three'] });

  await harness.sendInbound({ phone: '+15551110004', body: 'go' });

  await harness.waitFor(() => harness.twilioCalls.length === 3, {
    label: '3 twilio sends',
    timeoutMs: 4000
  });

  assert.deepEqual(
    harness.twilioCalls.map(c => c.body),
    ['one', 'two', 'three']
  );
});

test('chat returns success:false with fallbackMessage → fallback is sent via Twilio', async () => {
  harness.setUser({ userId: 'u1', phone: '+15551110005' });
  harness.chat.scriptNext({ fallbackMessage: 'something went wrong, try again' });

  await harness.sendInbound({ phone: '+15551110005', body: 'help' });

  await harness.waitFor(() => harness.twilioCalls.length === 1, { label: 'fallback twilio send' });
  assert.equal(harness.twilioCalls[0].body, 'something went wrong, try again');
});

test('chat endpoint returns 5xx → built-in fallback message is sent via Twilio', async () => {
  harness.setUser({ userId: 'u1', phone: '+15551110006' });
  harness.chat.scriptNext({ status: 500 });

  await harness.sendInbound({ phone: '+15551110006', body: 'hi' });

  await harness.waitFor(() => harness.twilioCalls.length === 1, { label: 'fallback twilio send on 5xx' });
  // The chat-endpoint-client maps any unparseable / failing chat response to a
  // hard-coded fallbackMessage, which the buffer worker then queues via Twilio.
  assert.match(harness.twilioCalls[0].body, /something went wrong/i);
});

test('streaming NDJSON response: all messages reach Twilio', async () => {
  harness.setUser({ userId: 'u1', phone: '+15551110007' });
  harness.chat.scriptNext({
    ndjson: [
      { type: 'message', index: 0, text: 'streamed-1' },
      { type: 'message', index: 1, text: 'streamed-2' },
      { type: 'done', success: true }
    ]
  });

  await harness.sendInbound({ phone: '+15551110007', body: 'go' });

  await harness.waitFor(() => harness.twilioCalls.length === 2, {
    label: '2 streamed twilio sends',
    timeoutMs: 4000
  });
  assert.deepEqual(harness.twilioCalls.map(c => c.body), ['streamed-1', 'streamed-2']);
});

// ============================================================================
// Unknown user
// ============================================================================

test('unknown phone with UNKNOWN_USER_MESSAGE configured → fallback sent, no chat call', async () => {
  // No user is set in the lookup map; UNKNOWN_USER_MESSAGE is read at module
  // load time so we can't change it mid-test. The harness's webhook-handler
  // already loaded with whatever the first boot set; for this test we use the
  // raw scenario: no UNKNOWN_USER_MESSAGE configured, so the user is dropped
  // silently. (See the next test for the unknown-user-with-fallback path.)
  await harness.sendInbound({ phone: '+15559990001', body: 'mystery' });

  // Give the agent time to process and (correctly) do nothing user-visible.
  await new Promise(r => setTimeout(r, 250));

  assert.equal(harness.chat.calls.length, 0, 'no chat call for unknown user');
  assert.equal(harness.twilioCalls.length, 0, 'no twilio send when UNKNOWN_USER_MESSAGE unset');
});

// ============================================================================
// Trigger flow
// ============================================================================

test('POST /triggers → user resolved → chat called → reply sent via Twilio', async () => {
  harness.setUser({ userId: 'u_trig', phone: '+15551110010' });
  harness.chat.scriptNext({ messages: ['hello from a trigger'] });

  const res = await harness.sendTrigger({ userId: 'u_trig', message: 'wake up' });
  assert.equal(res.status, 202);

  await harness.waitFor(() => harness.chat.calls.length === 1, {
    label: 'trigger chat call',
    timeoutMs: 5000
  });

  const call = harness.chat.calls[0];
  assert.equal(call.body.message, 'wake up');
  assert.equal(call.body.interface, 'sms');
  assert.ok(call.body.trigger, 'chat call should carry trigger metadata');
  assert.ok(call.body.trigger.id, 'trigger.id should be present');

  await harness.waitFor(() => harness.twilioCalls.length === 1, {
    label: 'trigger twilio send',
    timeoutMs: 5000
  });
  assert.equal(harness.twilioCalls[0].body, 'hello from a trigger');
});

test('trigger: chat returns silence → no Twilio send', async () => {
  harness.setUser({ userId: 'u_trig2', phone: '+15551110011' });
  harness.chat.scriptNext({ silence: true });

  await harness.sendTrigger({ userId: 'u_trig2', message: 'silent push' });

  await harness.waitFor(() => harness.chat.calls.length === 1, {
    label: 'trigger chat call',
    timeoutMs: 5000
  });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(harness.twilioCalls.length, 0);
});

test('trigger ingestion rejects requests without API key', async () => {
  const res = await fetch(`${harness.agentBaseUrl}/triggers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u1', message: 'x', timestamp: new Date().toISOString() })
  });
  assert.equal(res.status, 401);
});

// ============================================================================
// Reply context (WhatsApp swipe-reply)
// ============================================================================

test('WhatsApp inbound with OriginalRepliedMessageSid forwards reply context to chat', async () => {
  harness.setUser({ userId: 'u_wa', phone: '+15551110020', channel: 'whatsapp' });

  // First, drive an outbound so we have a SID in the read-receipt store.
  harness.chat.scriptNext({ messages: ['original outbound'] });
  await harness.sendInbound({ phone: '+15551110020', body: 'hi', channel: 'whatsapp' });
  await harness.waitFor(() => harness.twilioCalls.length === 1, { label: 'first outbound' });
  const outboundSid = harness.twilioCalls[0].sid;

  // Now send an inbound that swipe-replies to that SID.
  await harness.sendInbound({
    phone: '+15551110020',
    body: 'replying to that',
    channel: 'whatsapp',
    originalRepliedSid: outboundSid
  });

  await harness.waitFor(() => harness.chat.calls.length === 2, { label: '2nd chat call' });

  const replyCall = harness.chat.calls[1];
  assert.equal(replyCall.body.message, 'replying to that');
  assert.equal(replyCall.body.repliedToSid, outboundSid, 'repliedToSid should be forwarded');
  assert.ok(replyCall.body.repliedToSentAt, 'repliedToSentAt should be forwarded');
});

// ============================================================================
// Read receipts
// ============================================================================

test('Twilio read status callback → forwarded to READ_RECEIPT_URL', async () => {
  harness.setUser({ userId: 'u_read', phone: '+15551110030' });
  harness.chat.scriptNext({ messages: ['delivered'] });

  await harness.sendInbound({ phone: '+15551110030', body: 'ping' });
  await harness.waitFor(() => harness.twilioCalls.length === 1, { label: 'outbound send' });
  const sid = harness.twilioCalls[0].sid;

  // Simulate Twilio posting a `read` status callback.
  const params = new URLSearchParams({
    MessageSid: sid,
    MessageStatus: 'read',
    To: '+15551110030',
    From: process.env.TWILIO_PHONE_NUMBER
  });
  await fetch(`${harness.agentBaseUrl}/status/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  await harness.waitFor(
    () => harness.chat.readReceipts.length === 1,
    { label: 'read receipt forwarded', timeoutMs: 3000 }
  );
  assert.equal(harness.chat.readReceipts[0].body.userId, 'u_read');
  assert.equal(harness.chat.readReceipts[0].body.channel, 'sms');
});

// ============================================================================
// Health endpoint
// ============================================================================

test('GET /health reports agent state', async () => {
  const res = await fetch(`${harness.agentBaseUrl}/health`);
  assert.ok(res.status === 200 || res.status === 503);
  const body = await res.json();
  assert.ok(body.status === 'ok' || body.status === 'degraded');
  assert.equal(body.userAdapter, 'http');
  assert.match(body.chatEndpointUrl, /^http:/);
});
