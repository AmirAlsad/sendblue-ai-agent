/**
 * Unit tests for sendRedirectIfDue — the channel-mirrored Twilio dispatcher.
 *
 * Behavior under test:
 *   - When the rate-limit window is open AND a redirect message is configured
 *     (env var or per-call override), dispatches a Twilio message on the
 *     inbound's channel.
 *   - When rate-limited, returns { sent: false, reason: 'rate_limited' } and
 *     does NOT call Twilio.
 *   - When no message is configured (env unset, no override), the user is
 *     silently blocked — { sent: false, reason: 'no_message_configured' }.
 *   - When Twilio throws, returns { sent: false, reason: 'error' } and the
 *     caller continues (no exception thrown back up the stack).
 *   - The TTL window is shared across calls — second call within the window
 *     skips Twilio even if the first succeeded.
 *
 * Run with: node tests/unit/gate/redirect.test.js
 */

const assert = require('node:assert/strict');

// Set the env var BEFORE requiring gate.js so the module-level constant picks
// it up at load time.
process.env.GATE_REDIRECT_MESSAGE = 'You can\'t message right now.';

// In-memory Redis stub (same shape as rate-limit.test.js).
function createRedisStub() {
  const store = new Map();

  function isLive(key) {
    const entry = store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return false;
    }
    return true;
  }

  return {
    async set(key, value, ...args) {
      let ttlSeconds = null;
      let onlyIfNotExists = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === 'EX') ttlSeconds = parseInt(args[++i], 10);
        else if (a === 'NX') onlyIfNotExists = true;
      }
      if (onlyIfNotExists && isLive(key)) return null;
      const expiresAt = ttlSeconds !== null ? Date.now() + ttlSeconds * 1000 : null;
      store.set(key, { value, expiresAt });
      return 'OK';
    },
    _expireKey(key) { store.delete(key); }
  };
}

const redisStub = createRedisStub();

// Twilio mock — captures every sendMessage call.
const twilioCalls = [];
let twilioThrowOnNext = false;

require.cache[require.resolve('../../../src/utils/redis-client')] = {
  exports: { getClient: () => redisStub }
};
require.cache[require.resolve('../../../src/utils/twilio-client')] = {
  exports: {
    sendMessage: async (to, body, channel) => {
      twilioCalls.push({ to, body, channel });
      if (twilioThrowOnNext) {
        twilioThrowOnNext = false;
        throw new Error('simulated Twilio failure');
      }
      return { sid: `SM_${twilioCalls.length}` };
    }
  }
};

const { sendRedirectIfDue, REDIRECT_MESSAGE } = require('../../../src/utils/gate');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed += 1;
    })
    .catch(err => {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed += 1;
    });
}

(async () => {
  console.log('gate.sendRedirectIfDue');

  await test('first call dispatches Twilio with REDIRECT_MESSAGE on the SMS channel', async () => {
    redisStub._expireKey('gate:redirect:user-1');
    twilioCalls.length = 0;
    const out = await sendRedirectIfDue('user-1', '+15555550123', 'sms');
    assert.equal(out.sent, true);
    assert.equal(twilioCalls.length, 1);
    assert.equal(twilioCalls[0].to, '+15555550123');
    assert.equal(twilioCalls[0].body, REDIRECT_MESSAGE);
    assert.equal(twilioCalls[0].channel, 'sms');
    assert.match(out.messageSid, /^SM_/);
  });

  await test('first call dispatches Twilio on the WhatsApp channel for whatsapp inbounds', async () => {
    redisStub._expireKey('gate:redirect:user-2');
    twilioCalls.length = 0;
    const out = await sendRedirectIfDue('user-2', '+15555550456', 'whatsapp');
    assert.equal(out.sent, true);
    assert.equal(twilioCalls.length, 1);
    assert.equal(twilioCalls[0].channel, 'whatsapp');
  });

  await test('second call within the window does NOT call Twilio', async () => {
    redisStub._expireKey('gate:redirect:user-3');
    twilioCalls.length = 0;
    const first = await sendRedirectIfDue('user-3', '+15555550789', 'sms');
    assert.equal(first.sent, true);
    assert.equal(twilioCalls.length, 1);
    const second = await sendRedirectIfDue('user-3', '+15555550789', 'sms');
    assert.equal(second.sent, false);
    assert.equal(second.reason, 'rate_limited');
    assert.equal(twilioCalls.length, 1, 'Twilio should not be called a second time');
  });

  await test('after key expiry, Twilio is dispatched again', async () => {
    redisStub._expireKey('gate:redirect:user-4');
    twilioCalls.length = 0;
    const first = await sendRedirectIfDue('user-4', '+15555550100', 'sms');
    assert.equal(first.sent, true);
    redisStub._expireKey('gate:redirect:user-4'); // simulate TTL elapsed
    const second = await sendRedirectIfDue('user-4', '+15555550100', 'sms');
    assert.equal(second.sent, true);
    assert.equal(twilioCalls.length, 2);
  });

  await test('Twilio throwing returns { sent: false, reason: error } without bubbling', async () => {
    redisStub._expireKey('gate:redirect:user-5');
    twilioCalls.length = 0;
    twilioThrowOnNext = true;
    const out = await sendRedirectIfDue('user-5', '+15555550111', 'sms');
    assert.equal(out.sent, false);
    assert.equal(out.reason, 'error');
    assert.equal(twilioCalls.length, 1, 'Twilio is called once before failing');
  });

  await test('different users get independent dispatches', async () => {
    redisStub._expireKey('gate:redirect:user-6a');
    redisStub._expireKey('gate:redirect:user-6b');
    twilioCalls.length = 0;
    const a = await sendRedirectIfDue('user-6a', '+15555556001', 'sms');
    const b = await sendRedirectIfDue('user-6b', '+15555556002', 'sms');
    assert.equal(a.sent, true);
    assert.equal(b.sent, true);
    assert.equal(twilioCalls.length, 2);
    assert.equal(twilioCalls[0].to, '+15555556001');
    assert.equal(twilioCalls[1].to, '+15555556002');
  });

  await test('per-call override message wins over GATE_REDIRECT_MESSAGE', async () => {
    redisStub._expireKey('gate:redirect:user-7');
    twilioCalls.length = 0;
    const out = await sendRedirectIfDue('user-7', '+15555550999', 'sms', 'Custom override message');
    assert.equal(out.sent, true);
    assert.equal(twilioCalls.length, 1);
    assert.equal(twilioCalls[0].body, 'Custom override message');
  });

  await test('empty redirect message + no override → silent block, no Twilio call', async () => {
    // Re-require gate with the env var unset to test the disabled-redirect path.
    const original = process.env.GATE_REDIRECT_MESSAGE;
    delete process.env.GATE_REDIRECT_MESSAGE;
    delete require.cache[require.resolve('../../../src/utils/gate')];
    try {
      const fresh = require('../../../src/utils/gate');
      redisStub._expireKey('gate:redirect:user-8');
      twilioCalls.length = 0;
      const out = await fresh.sendRedirectIfDue('user-8', '+15555550000', 'sms');
      assert.equal(out.sent, false);
      assert.equal(out.reason, 'no_message_configured');
      assert.equal(twilioCalls.length, 0);
    } finally {
      process.env.GATE_REDIRECT_MESSAGE = original;
      delete require.cache[require.resolve('../../../src/utils/gate')];
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
