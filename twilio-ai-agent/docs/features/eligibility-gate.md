# Eligibility Gate (optional)

## What it does

An opt-in predicate gate that decides whether a user is allowed to message the AI right now (inbound) or to receive an out-of-band message (trigger). Blocked inbound users get an optional rate-limited redirect message; blocked triggers are dead-lettered.

The gate is **off by default**. It activates when:
- `./adapters/user.js` exports an `isEligible({userId, data})` function, OR
- `GATE_ELIGIBILITY_URL` is set (HTTP webhook)

## How it works

After user resolution and before any state-machine work, the handler calls the predicate. The predicate receives `{userId, data}` (where `data` is whatever the user adapter returned in the user record's `data` field) and returns:

- `true` — allow
- `false` — block silently (or with the configured `GATE_REDIRECT_MESSAGE` if set)
- `{allowed: false, redirect: "Custom message"}` — block with a per-call override

When blocked inbound, the package calls `sendRedirectIfDue(userId, phone, channel, redirect)`. This atomically claims a per-user redirect window in Redis (`SET ... EX TTL NX`). Within the window, no redirect is sent. The window applies across SMS and WhatsApp (single Redis key per user).

The redirect is **channel-mirrored**: SMS in produces SMS out, WhatsApp in produces WhatsApp out, using the existing Twilio sender wrapper. If `GATE_REDIRECT_MESSAGE` and the per-call override are both empty, the user is silently blocked with no Twilio send.

The redirect Redis check fails open: if Redis is unavailable, the redirect is allowed. The predicate itself fails open too: if it throws, the user is allowed through (gate logs a warning).

For triggers, the gate runs at the top of `processTrigger`. Blocked triggers return `{type: FAILED, error: 'gated_ineligible'}` — the worker dead-letters them with no retry, no Twilio send, no chat-endpoint call.

## Code files

| File | Role |
| --- | --- |
| `src/utils/gate.js` | Predicate evaluation, Redis-backed redirect rate limit, channel-mirrored Twilio dispatch |
| `src/routes/webhook-handler.js` | Inbound chokepoint — calls the gate after user resolution |
| `src/triggers/trigger-processor.js` | Outbound chokepoint — same predicate, dead-letter on block |
| `src/adapters/user-adapter.js` | Predicate is loaded from the JS adapter or the HTTP `GATE_ELIGIBILITY_URL` |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GATE_REDIRECT_TTL_SECONDS` | `86400` | Per-user cooldown between redirect-to-app messages (seconds). Same key shared across SMS and WhatsApp. |
| `GATE_REDIRECT_MESSAGE` | `''` (empty) | Body of the redirect. Empty disables the message (gate still blocks). Per-call `redirect` override on the predicate result wins. |
| `GATE_ELIGIBILITY_URL` | `''` | HTTP eligibility webhook. Used only when the JS adapter doesn't export `isEligible`. Package POSTs `{userId, data}` and expects `{allowed: bool, redirect?: string}` or a bare boolean. |

## Known limitations

- Predicate failures fail open (allow). If you need fail-closed semantics, wrap your predicate with a try/catch that returns `false`.
- Redirect rate limiting is per user, not per phone — if a user has multiple phone numbers in your system, they share a single redirect window.
- The gate runs synchronously before buffering, so a slow predicate slows the inbound webhook response.
