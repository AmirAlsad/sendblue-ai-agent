# Unit tests

Zero-dep Node tests using `node:assert/strict`. Each `*.test.js` is launched as its own child process by `tests/unit/run-all.js`, so module-level mocks (Redis, Twilio) don't leak between files.

For tests that need a live HTTP chat endpoint (response shaping, NDJSON streaming, failure injection, call inspection), use `node:test` integration tests in `tests/integration/` — they reuse the helper at `tests/integration/helpers/chat-endpoint.js` (an in-process wrapper around `examples/test-chat-endpoint/app.js`).

## Running

```bash
npm run test:unit                    # everything
npm run test:unit -- --grep gate     # only files whose path contains "gate"
```

## Layout

```
tests/unit/
├── run-all.js                 # child-process-per-file runner
├── README.md                  # this file
└── gate/
    ├── eligibility.test.js    # evaluate(predicate, userRecord) — pluggable predicate behavior
    ├── rate-limit.test.js     # shouldSendRedirect — Redis SET … NX EX semantics
    └── redirect.test.js       # sendRedirectIfDue — channel-mirrored Twilio dispatch
```

## Conventions

- One `test(name, fn)` per scenario; `passed`/`failed` counters; `process.exit(1)` on failure.
- External services (Redis, Twilio) are mocked via `require.cache` injection BEFORE the unit-under-test is required. See `gate/rate-limit.test.js` and `gate/redirect.test.js` for the pattern.
- Tests are pure: no real network, no real Redis, no real Twilio.

## Adding tests for a new module

1. Create `tests/unit/<area>/<name>.test.js`.
2. If the module imports Redis/Twilio at require-time, stub them via `require.cache[require.resolve('../../../src/<path>')] = { exports: {...} }` before requiring the unit-under-test.
3. End with `console.log(\`\\n${passed} passed, ${failed} failed\`); process.exit(failed === 0 ? 0 : 1);`.
4. The runner picks it up automatically — no need to register.
