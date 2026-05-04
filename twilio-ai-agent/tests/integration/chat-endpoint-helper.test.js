// Self-test for the test-chat-endpoint helper.
//
// This test exercises the helper itself end-to-end (over real HTTP, with
// fetch as the client) so that downstream integration tests can rely on it.
// It does NOT involve the twilio-ai-agent package or Redis.
//
// Run with: node --test tests/integration/chat-endpoint-helper.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEndpoint } = require('./helpers/chat-endpoint');

async function postChat(url, body) {
  const res = await fetch(`${url}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('ndjson')) {
    const text = await res.text();
    const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { status: res.status, contentType, lines };
  }
  if (contentType.includes('json')) {
    return { status: res.status, contentType, body: await res.json() };
  }
  return { status: res.status, contentType, body: await res.text() };
}

test('default behavior is echo', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    const res = await postChat(endpoint.url, { userId: 'u1', message: 'hello' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, messages: ['echo: hello'] });
  } finally {
    await endpoint.close();
  }
});

test('scriptNext consumes the next response', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.scriptNext({ messages: ['scripted'] });
    const res1 = await postChat(endpoint.url, { message: 'first' });
    assert.deepEqual(res1.body, { success: true, messages: ['scripted'] });

    // Next call falls back to echo.
    const res2 = await postChat(endpoint.url, { message: 'second' });
    assert.deepEqual(res2.body, { success: true, messages: ['echo: second'] });
  } finally {
    await endpoint.close();
  }
});

test('scriptMany pushes a batch in FIFO order', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.scriptMany([
      { messages: ['one'] },
      { silence: true },
      { fallbackMessage: 'oops' }
    ]);

    const r1 = await postChat(endpoint.url, { message: 'a' });
    const r2 = await postChat(endpoint.url, { message: 'b' });
    const r3 = await postChat(endpoint.url, { message: 'c' });

    assert.deepEqual(r1.body, { success: true, messages: ['one'] });
    assert.deepEqual(r2.body, { success: true, silence: true });
    assert.deepEqual(r3.body, { success: false, fallbackMessage: 'oops' });
  } finally {
    await endpoint.close();
  }
});

test('NDJSON streaming response', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.scriptNext({
      ndjson: [
        { type: 'message', index: 0, text: 'first' },
        { type: 'message', index: 1, text: 'second' },
        { type: 'done', success: true }
      ]
    });

    const res = await postChat(endpoint.url, { message: 'go' });
    assert.match(res.contentType, /ndjson/);
    assert.equal(res.lines.length, 3);
    assert.deepEqual(res.lines[0], { type: 'message', index: 0, text: 'first' });
    assert.deepEqual(res.lines[2], { type: 'done', success: true });
  } finally {
    await endpoint.close();
  }
});

test('rules match before script and consume on `once`', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.setRule(
      req => req.body.userId === 'u_paid',
      { messages: ['premium reply'] }
    );
    endpoint.scriptNext({ messages: ['queue reply'] });

    // Rule matches u_paid first.
    const r1 = await postChat(endpoint.url, { userId: 'u_paid', message: 'a' });
    assert.deepEqual(r1.body.messages, ['premium reply']);

    // Non-matching userId falls through to script queue.
    const r2 = await postChat(endpoint.url, { userId: 'u_free', message: 'b' });
    assert.deepEqual(r2.body.messages, ['queue reply']);

    // Rule still matches (not `once`).
    const r3 = await postChat(endpoint.url, { userId: 'u_paid', message: 'c' });
    assert.deepEqual(r3.body.messages, ['premium reply']);
  } finally {
    await endpoint.close();
  }
});

test('once: true rules are removed after first match', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.setRule(/book/i, { messages: ['booked'] }, { once: true });

    const r1 = await postChat(endpoint.url, { message: 'I want to book' });
    assert.deepEqual(r1.body.messages, ['booked']);

    const r2 = await postChat(endpoint.url, { message: 'book again' });
    assert.deepEqual(r2.body.messages, ['echo: book again']);
  } finally {
    await endpoint.close();
  }
});

test('setDefault changes the fallback', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.setDefault({ silence: true });
    const res = await postChat(endpoint.url, { message: 'whatever' });
    assert.deepEqual(res.body, { success: true, silence: true });
  } finally {
    await endpoint.close();
  }
});

test('5xx status responses', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.scriptNext({ status: 503, body: 'service unavailable' });
    const res = await postChat(endpoint.url, { message: 'a' });
    assert.equal(res.status, 503);
  } finally {
    await endpoint.close();
  }
});

test('throw destroys the socket (connection error on the client)', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.scriptNext({ throw: true });
    let caught = null;
    try {
      await postChat(endpoint.url, { message: 'a' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected fetch to throw on socket destroy');
  } finally {
    await endpoint.close();
  }
});

test('delayMs delays the response', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.scriptNext({ messages: ['slow'], delayMs: 150 });
    const t0 = Date.now();
    const res = await postChat(endpoint.url, { message: 'a' });
    const elapsed = Date.now() - t0;
    assert.deepEqual(res.body.messages, ['slow']);
    assert.ok(elapsed >= 140, `expected ≥ 140ms, got ${elapsed}ms`);
  } finally {
    await endpoint.close();
  }
});

test('calls inspector captures every request body', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    await postChat(endpoint.url, { userId: 'u1', message: 'first' });
    await postChat(endpoint.url, { userId: 'u2', message: 'second' });

    assert.equal(endpoint.calls.length, 2);
    assert.equal(endpoint.calls[0].body.message, 'first');
    assert.equal(endpoint.calls[1].body.userId, 'u2');
    assert.equal(endpoint.calls[0].path, '/chat');
  } finally {
    await endpoint.close();
  }
});

test('reset clears scripts, rules, and calls', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    endpoint.scriptNext({ messages: ['stale'] });
    endpoint.setRule(/x/, { messages: ['ruled'] });
    await postChat(endpoint.url, { message: 'noise' });

    endpoint.reset();
    assert.equal(endpoint.calls.length, 0);

    const res = await postChat(endpoint.url, { message: 'fresh' });
    assert.deepEqual(res.body.messages, ['echo: fresh']);
  } finally {
    await endpoint.close();
  }
});

test('read-receipt endpoint captures payload separately', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    const res = await fetch(`${endpoint.url}/read-receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', readAt: '2026-05-03T12:00:00Z', channel: 'sms' })
    });
    assert.equal(res.status, 200);
    assert.equal(endpoint.readReceipts.length, 1);
    assert.equal(endpoint.readReceipts[0].body.userId, 'u1');
    assert.equal(endpoint.calls.length, 0, 'read receipts should not appear in /chat call log');
  } finally {
    await endpoint.close();
  }
});

test('admin HTTP control plane works end-to-end', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    // Push a script via HTTP (mirrors how a non-Node test runner would drive it).
    await fetch(`${endpoint.url}/_admin/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: { messages: ['from admin'] } })
    });

    const res = await postChat(endpoint.url, { message: 'a' });
    assert.deepEqual(res.body.messages, ['from admin']);

    // Inspect via HTTP.
    const callsRes = await fetch(`${endpoint.url}/_admin/calls`);
    const callsBody = await callsRes.json();
    assert.equal(callsBody.calls.length, 1);

    // Reset via HTTP.
    await fetch(`${endpoint.url}/_admin/reset`, { method: 'POST' });
    assert.equal(endpoint.calls.length, 0);
  } finally {
    await endpoint.close();
  }
});

test('regex rule via HTTP control plane', async () => {
  const endpoint = createTestEndpoint();
  await endpoint.listen(0);
  try {
    await fetch(`${endpoint.url}/_admin/rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matcher: { regex: 'cancel', flags: 'i' },
        response: { messages: ['cancelled'] }
      })
    });

    const r1 = await postChat(endpoint.url, { message: 'please CANCEL' });
    assert.deepEqual(r1.body.messages, ['cancelled']);

    const r2 = await postChat(endpoint.url, { message: 'something else' });
    assert.deepEqual(r2.body.messages, ['echo: something else']);
  } finally {
    await endpoint.close();
  }
});
