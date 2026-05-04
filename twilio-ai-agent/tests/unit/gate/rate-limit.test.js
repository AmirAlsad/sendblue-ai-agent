/**
 * Unit tests for the gate's per-user redirect rate-limit.
 *
 * gate.shouldSendRedirect uses Redis SET key val EX ttl NX semantics:
 *   - First call sets the key, returns 'OK' → caller should send.
 *   - Subsequent calls within the TTL window get null → caller should skip.
 *   - After expiry, the SET succeeds again → caller should send.
 *
 * Failure modes (gate must fail-OPEN for Redis errors so a Redis outage
 * doesn't permanently silence the redirect):
 *   - getClient() returns null (Redis not configured) → return true.
 *   - client.set throws → return true.
 *
 * Run with: node tests/unit/gate/rate-limit.test.js
 */

const assert = require('node:assert/strict');

// -----------------------------------------------------------------------------
// In-memory Redis stub — only the surface we depend on (SET ... EX ttl NX, GET).
// Includes test helpers for fast-forwarding TTL and clearing state without
// real wall-clock time.
// -----------------------------------------------------------------------------

function createRedisStub() {
  const store = new Map(); // key -> { value, expiresAt|null }

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
        if (a === 'EX') {
          ttlSeconds = parseInt(args[++i], 10);
        } else if (a === 'NX') {
          onlyIfNotExists = true;
        }
      }
      if (onlyIfNotExists && isLive(key)) {
        return null;
      }
      const expiresAt = ttlSeconds !== null ? Date.now() + ttlSeconds * 1000 : null;
      store.set(key, { value, expiresAt });
      return 'OK';
    },

    async get(key) {
      if (!isLive(key)) return null;
      return store.get(key).value;
    },

    // Test helpers ------------------------------------------------------------
    _expireKey(key) {
      store.delete(key);
    },
    _hasKey(key) {
      return isLive(key);
    },
    _peekTtlMs(key) {
      const entry = store.get(key);
      if (!entry || entry.expiresAt === null) return null;
      return entry.expiresAt - Date.now();
    },
  };
}

// Hold a single shared stub across the whole file so each test can mutate it.
const redisStub = createRedisStub();
let throwOnNextSet = false;

// Inject the stub before gate.js is required.
require.cache[require.resolve('../../../src/utils/redis-client')] = {
  exports: {
    getClient: () => ({
      ...redisStub,
      set: async (...args) => {
        if (throwOnNextSet) {
          throwOnNextSet = false;
          throw new Error('simulated Redis failure');
        }
        return redisStub.set(...args);
      },
    }),
  },
};
require.cache[require.resolve('../../../src/utils/twilio-client')] = {
  exports: { sendMessage: async () => ({ sid: 'SM_unused' }) }
};

const { shouldSendRedirect, REDIRECT_TTL_SECONDS } = require('../../../src/utils/gate');

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
  console.log('gate.shouldSendRedirect');

  await test('first call for a user sets the key and returns true', async () => {
    redisStub._expireKey('gate:redirect:user-A');
    const out = await shouldSendRedirect('user-A');
    assert.equal(out, true);
    assert.equal(redisStub._hasKey('gate:redirect:user-A'), true);
  });

  await test('second call within the window returns false (rate-limited)', async () => {
    redisStub._expireKey('gate:redirect:user-B');
    const first = await shouldSendRedirect('user-B');
    assert.equal(first, true);
    const second = await shouldSendRedirect('user-B');
    assert.equal(second, false);
  });

  await test('after key expiry, returns true again', async () => {
    redisStub._expireKey('gate:redirect:user-C');
    const first = await shouldSendRedirect('user-C');
    assert.equal(first, true);
    redisStub._expireKey('gate:redirect:user-C'); // simulate TTL elapsed
    const third = await shouldSendRedirect('user-C');
    assert.equal(third, true);
  });

  await test('different users have independent rate-limit windows', async () => {
    redisStub._expireKey('gate:redirect:user-D');
    redisStub._expireKey('gate:redirect:user-E');
    const dFirst = await shouldSendRedirect('user-D');
    const eFirst = await shouldSendRedirect('user-E');
    assert.equal(dFirst, true);
    assert.equal(eFirst, true);
    const dSecond = await shouldSendRedirect('user-D');
    const eSecond = await shouldSendRedirect('user-E');
    assert.equal(dSecond, false, 'user-D second call should be rate-limited');
    assert.equal(eSecond, false, 'user-E second call should be rate-limited');
  });

  await test('TTL is set to REDIRECT_TTL_SECONDS', async () => {
    redisStub._expireKey('gate:redirect:user-F');
    await shouldSendRedirect('user-F');
    const ttlMs = redisStub._peekTtlMs('gate:redirect:user-F');
    assert.notEqual(ttlMs, null, 'expiry must be set');
    // Allow a generous lower bound — test execution can shave a few ms off.
    const expectedMs = REDIRECT_TTL_SECONDS * 1000;
    assert.ok(
      ttlMs > expectedMs - 5_000 && ttlMs <= expectedMs,
      `expected ttl ≈ ${expectedMs}ms, got ${ttlMs}ms`
    );
  });

  await test('Redis client throwing falls open (returns true)', async () => {
    redisStub._expireKey('gate:redirect:user-G');
    throwOnNextSet = true;
    const out = await shouldSendRedirect('user-G');
    assert.equal(out, true, 'Redis errors must NOT permanently silence the gate');
  });

  // Replace the cached redis-client to simulate Redis-not-configured.
  await test('getClient returning null falls open (returns true)', async () => {
    const original = require.cache[require.resolve('../../../src/utils/redis-client')];
    require.cache[require.resolve('../../../src/utils/redis-client')] = {
      exports: { getClient: () => null }
    };
    // Re-require gate to pick up the new client lookup.
    delete require.cache[require.resolve('../../../src/utils/gate')];
    const { shouldSendRedirect: freshShould } = require('../../../src/utils/gate');
    try {
      const out = await freshShould('user-H');
      assert.equal(out, true);
    } finally {
      // Restore for any subsequent tests.
      require.cache[require.resolve('../../../src/utils/redis-client')] = original;
      delete require.cache[require.resolve('../../../src/utils/gate')];
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
