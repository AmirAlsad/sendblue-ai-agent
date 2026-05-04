/**
 * Unit tests for the pluggable gate predicate evaluator.
 *
 * The gate is off by default — when no predicate is supplied, evaluate()
 * returns { allowed: true }. When a predicate is supplied, it can return
 * either a bare boolean or { allowed: bool, redirect?: string }, which
 * evaluate() normalizes.
 *
 * Predicate exceptions fail-OPEN (return { allowed: true }) so a bug in the
 * consumer's predicate doesn't permanently block all messaging.
 *
 * Run with: node tests/unit/gate/eligibility.test.js
 */

const assert = require('node:assert/strict');

// gate.js loads redis-client + twilio-client at require-time. Stub both with
// no-op shims so loading this file in isolation doesn't try to talk to real
// services (the predicate-evaluation path doesn't need either).
require.cache[require.resolve('../../../src/utils/redis-client')] = {
  exports: { getClient: () => null }
};
require.cache[require.resolve('../../../src/utils/twilio-client')] = {
  exports: { sendMessage: async () => ({ sid: 'SM_unused' }) }
};

const { evaluate } = require('../../../src/utils/gate');

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
  console.log('gate.evaluate');

  // ---------------------------------------------------------------------------
  // No predicate → always allow (gate is off)
  // ---------------------------------------------------------------------------

  await test('no predicate → { allowed: true }', async () => {
    const out = await evaluate(undefined, { userId: 'u1', data: {} });
    assert.deepEqual(out, { allowed: true });
  });

  await test('null predicate → { allowed: true }', async () => {
    const out = await evaluate(null, { userId: 'u1', data: {} });
    assert.deepEqual(out, { allowed: true });
  });

  await test('non-function predicate → { allowed: true }', async () => {
    const out = await evaluate('not-a-fn', { userId: 'u1', data: {} });
    assert.deepEqual(out, { allowed: true });
  });

  // ---------------------------------------------------------------------------
  // Boolean predicates
  // ---------------------------------------------------------------------------

  await test('predicate returns true → allowed', async () => {
    const out = await evaluate(async () => true, { userId: 'u1' });
    assert.equal(out.allowed, true);
  });

  await test('predicate returns false → blocked, no redirect', async () => {
    const out = await evaluate(async () => false, { userId: 'u1' });
    assert.equal(out.allowed, false);
    assert.equal(out.redirect, undefined);
  });

  // ---------------------------------------------------------------------------
  // Object predicates with redirect override
  // ---------------------------------------------------------------------------

  await test('predicate returns { allowed: false, redirect: "..." } → blocked with override', async () => {
    const out = await evaluate(
      async () => ({ allowed: false, redirect: 'Upgrade to keep messaging' }),
      { userId: 'u1' }
    );
    assert.equal(out.allowed, false);
    assert.equal(out.redirect, 'Upgrade to keep messaging');
  });

  await test('predicate returns { allowed: true, redirect: "..." } → allowed (redirect ignored)', async () => {
    const out = await evaluate(
      async () => ({ allowed: true, redirect: 'unused' }),
      { userId: 'u1' }
    );
    assert.equal(out.allowed, true);
  });

  await test('predicate returns object without `allowed` → defaults to allowed=true', async () => {
    const out = await evaluate(async () => ({}), { userId: 'u1' });
    assert.equal(out.allowed, true);
  });

  // ---------------------------------------------------------------------------
  // Predicate sees the user record
  // ---------------------------------------------------------------------------

  await test('predicate receives { userId, data }', async () => {
    let received;
    const predicate = async (input) => {
      received = input;
      return true;
    };
    await evaluate(predicate, { userId: 'u_abc', data: { tier: 'premium' } });
    assert.deepEqual(received, { userId: 'u_abc', data: { tier: 'premium' } });
  });

  await test('a tier-based predicate blocks free users and allows paid', async () => {
    const predicate = async ({ data }) => data?.tier === 'paid';
    const free = await evaluate(predicate, { userId: 'u1', data: { tier: 'free' } });
    const paid = await evaluate(predicate, { userId: 'u2', data: { tier: 'paid' } });
    assert.equal(free.allowed, false);
    assert.equal(paid.allowed, true);
  });

  // ---------------------------------------------------------------------------
  // Defensive — predicate exception fails OPEN
  // ---------------------------------------------------------------------------

  await test('predicate throws → fail open (allowed: true)', async () => {
    const predicate = async () => { throw new Error('boom'); };
    const out = await evaluate(predicate, { userId: 'u1' });
    assert.equal(out.allowed, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
