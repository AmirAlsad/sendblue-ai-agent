// Boots the twilio-ai-agent against mock backends for integration testing.
//
// Wiring:
//   - Twilio sender + typing-indicator are mocked via require.cache (so the
//     test never makes real Twilio calls). The mock simulates Twilio's
//     status-callback choreography by POSTing `delivered` callbacks back to
//     the agent so the outbound queue advances as it would in production.
//   - Chat endpoint is the test-chat-endpoint helper (in-process, programmable).
//   - User-lookup is a tiny in-process Express stub with a JS map. Tests can
//     mutate `harness.users` to add/remove records.
//   - Redis is real. The harness uses Redis DB index 15 by default so it
//     doesn't collide with a developer's local data. Set TEST_REDIS_URL to
//     override.
//
// IMPORTANT: this helper mutates the require.cache. Use `node --test` (which
// runs each test file in its own subprocess by default) to keep state
// isolated between test files. Within a file, call `harness.reset()` between
// tests to clear Redis state, the chat endpoint script, and Twilio call
// records.

const express = require('express');
const path = require('path');

const { createTestEndpoint } = require('./chat-endpoint');

function defaultRedisUrl() {
  return process.env.TEST_REDIS_URL || 'redis://localhost:6379/15';
}

async function bootHarness({ bufferMs = 100 } = {}) {
  // ---------------------------------------------------------------------------
  // Test env. Must be set BEFORE we require any agent modules.
  // ---------------------------------------------------------------------------
  process.env.AGENT_NO_AUTOSTART = '1';
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  process.env.PORT = '0';
  process.env.REDIS_URL = process.env.REDIS_URL || defaultRedisUrl();
  process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test_token';
  process.env.TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '+15550000000';
  process.env.TRIGGER_API_KEY = process.env.TRIGGER_API_KEY || 'test_trigger_key';
  process.env.BUFFER_BASE_TIMEOUT_MS = String(bufferMs);
  process.env.BUFFER_MAX_TIMEOUT_MS = String(bufferMs * 2);
  process.env.BUFFER_NOISE_MAX_DEVIATION = '0';
  process.env.TRIGGER_POLL_INTERVAL_MS = '50';
  process.env.MAX_REPROCESS_ATTEMPTS = '0';

  // ---------------------------------------------------------------------------
  // 1. Start mock chat endpoint + mock user-lookup webhook on random ports.
  //    These need URLs we can put in env vars before requiring the agent.
  // ---------------------------------------------------------------------------
  const chat = createTestEndpoint();
  await chat.listen(0);

  const users = new Map(); // phone -> {userId, channel, data}
  const usersById = new Map(); // userId -> {phone, channel, data}

  const lookupApp = express();
  lookupApp.use(express.json());
  lookupApp.post('/lookup', (req, res) => {
    const { resolveBy, value } = req.body || {};
    if (resolveBy === 'phone') {
      const u = users.get(value);
      if (!u) return res.json(null);
      return res.json({ userId: u.userId, phone: value, channel: u.channel || 'sms', data: u.data });
    }
    if (resolveBy === 'userId') {
      const u = usersById.get(value);
      if (!u) return res.json(null);
      return res.json({ userId: value, phone: u.phone, channel: u.channel || 'sms', data: u.data });
    }
    if (resolveBy === 'listActive') {
      return res.json({ users: Array.from(usersById.keys()), nextCursor: null });
    }
    res.status(400).json({ error: 'unknown resolveBy' });
  });
  const lookupServer = await new Promise((resolve, reject) => {
    const s = lookupApp.listen(0, () => resolve(s));
    s.on('error', reject);
  });
  const lookupUrl = `http://localhost:${lookupServer.address().port}`;

  process.env.CHAT_ENDPOINT_URL = `${chat.url}/chat`;
  process.env.READ_RECEIPT_URL = `${chat.url}/read-receipt`;
  process.env.USER_LOOKUP_URL = `${lookupUrl}/lookup`;

  // ---------------------------------------------------------------------------
  // 2. Mock Twilio sender + typing indicator via require.cache. Must happen
  //    before any agent module requires them.
  // ---------------------------------------------------------------------------
  const twilioCalls = [];
  let twilioSendShouldThrow = null;
  let agentBaseUrl = null; // set after server.listen below; nulled in shutdown
  const inFlightCallbacks = new Set(); // tracks pending status-callback fetches

  function resolveTwilioClientPath() {
    return require.resolve(path.resolve(__dirname, '../../../src/utils/twilio-client'));
  }
  function resolveTwilioTypingPath() {
    return require.resolve(path.resolve(__dirname, '../../../src/utils/twilio-typing'));
  }

  require.cache[resolveTwilioClientPath()] = {
    exports: {
      sendMessage: async (to, body, channel) => {
        if (twilioSendShouldThrow) {
          const err = twilioSendShouldThrow;
          twilioSendShouldThrow = null;
          throw err;
        }
        const sid = `SM_test_${Date.now()}_${twilioCalls.length}`;
        twilioCalls.push({ to, body, channel, sid, sentAt: new Date().toISOString() });
        // Simulate Twilio posting a delivered callback so the outbound queue
        // advances. Use setImmediate so the current sendMessage call resolves
        // before the queue manager processes the callback (mirrors the
        // real-world flow where the API response returns first).
        setImmediate(() => {
          if (!agentBaseUrl) return;
          const params = new URLSearchParams({
            MessageSid: sid,
            MessageStatus: 'delivered',
            To: channel === 'whatsapp' ? `whatsapp:${to}` : to,
            From: process.env.TWILIO_PHONE_NUMBER
          });
          const controller = new AbortController();
          inFlightCallbacks.add(controller);
          fetch(`${agentBaseUrl}/status/callback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
            signal: controller.signal
          })
            .catch(() => { /* ignore — fetch may abort during shutdown */ })
            .finally(() => inFlightCallbacks.delete(controller));
        });
        return { sid };
      },
      // Used in the redirect flow tests
      _setNextSendError(err) { twilioSendShouldThrow = err; }
    }
  };

  require.cache[resolveTwilioTypingPath()] = {
    exports: {
      sendTypingIndicator: async () => { /* no-op in tests */ }
    }
  };

  // ---------------------------------------------------------------------------
  // 3. Require + start the agent with the mocks in place.
  // ---------------------------------------------------------------------------
  const agent = require('../../../src/index');
  process.env.STATUS_CALLBACK_URL = process.env.STATUS_CALLBACK_URL || 'http://placeholder/status/callback';
  const { server, port } = await agent.start({ port: 0 });
  agentBaseUrl = `http://localhost:${port}`;

  const redisClient = require('../../../src/utils/redis-client');
  const { deleteState } = require('../../../src/state/conversation-state');

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  function setUser({ userId, phone, channel = 'sms', data }) {
    users.set(phone, { userId, channel, data });
    usersById.set(userId, { phone, channel, data });
  }

  function clearUsers() {
    users.clear();
    usersById.clear();
  }

  async function sendInbound({ phone, body, channel = 'sms', messageSid, originalRepliedSid } = {}) {
    const fromHeader = channel === 'whatsapp' ? `whatsapp:${phone}` : phone;
    const sid = messageSid || `SM_inbound_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const params = new URLSearchParams({
      From: fromHeader,
      To: channel === 'whatsapp' ? `whatsapp:${process.env.TWILIO_PHONE_NUMBER}` : process.env.TWILIO_PHONE_NUMBER,
      Body: body,
      MessageSid: sid
    });
    if (originalRepliedSid) params.set('OriginalRepliedMessageSid', originalRepliedSid);

    const route = channel === 'whatsapp' ? '/whatsapp/webhook' : '/sms/webhook';
    const res = await fetch(`${agentBaseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    return { status: res.status, sid };
  }

  async function sendTrigger(payload) {
    return fetch(`${agentBaseUrl}/triggers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trigger-API-Key': process.env.TRIGGER_API_KEY
      },
      body: JSON.stringify({ timestamp: new Date().toISOString(), ...payload })
    });
  }

  async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25, label = 'condition' } = {}) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await predicate();
        if (result) return result;
      } catch (err) {
        lastErr = err;
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    const msg = `waitFor("${label}") timed out after ${timeoutMs}ms`;
    if (lastErr) throw new Error(`${msg}: ${lastErr.message}`);
    throw new Error(msg);
  }

  async function flushRedis() {
    const client = redisClient.getClient();
    if (client) await client.flushdb();
  }

  async function drainInFlight(timeoutMs = 250) {
    // Wait briefly for any in-flight Twilio status-callback fetches to land
    // and any pending setImmediate callbacks to fire. Prevents stale work
    // from a previous test bleeding into the next.
    const start = Date.now();
    while (inFlightCallbacks.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 10));
    }
    // One more macrotask tick so anything just-scheduled lands.
    await new Promise(r => setImmediate(r));
  }

  async function reset() {
    await drainInFlight();
    chat.reset();
    twilioCalls.length = 0;
    twilioSendShouldThrow = null;
    clearUsers();
    await flushRedis();
  }

  async function shutdown() {
    // Stop accepting new status-callback fetches first so any pending
    // setImmediate callbacks become no-ops, then abort the ones already in
    // flight so node-fetch / Undici doesn't keep the event loop alive.
    const previousAgentUrl = agentBaseUrl;
    agentBaseUrl = null;
    for (const controller of inFlightCallbacks) {
      try { controller.abort(); } catch (_) { /* ignore */ }
    }
    inFlightCallbacks.clear();

    // Force-close keepalive connections on the mock servers so close() returns
    // promptly instead of waiting for the keepalive idle timeout.
    try { lookupServer.closeAllConnections?.(); } catch (_) { /* ignore */ }
    await chat.close().catch(() => {});
    await new Promise(resolve => lookupServer.close(resolve));
    await agent.stop();
    void previousAgentUrl; // referenced for potential debugging
  }

  return {
    agentBaseUrl,
    chat,
    twilioCalls,
    setUser,
    clearUsers,
    sendInbound,
    sendTrigger,
    waitFor,
    flushRedis,
    reset,
    shutdown,
    setNextTwilioSendError: (err) => {
      const mod = require.cache[resolveTwilioClientPath()];
      mod.exports._setNextSendError(err);
    }
  };
}

module.exports = { bootHarness };
