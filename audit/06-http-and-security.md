# Slice 6 audit: HTTP App and Webhook Security

## Summary

Sendblue has documented the webhook signing header (`sb-signing-secret`,
literal shared-secret string) since AGENTS.md was last updated, and the
implementation already happens to use that exact header — but `validateWebhookSecret`
was using a non-constant-time `===` comparison and the auth-failure path
provided minimal diagnostic logging. Route coverage, response codes, body
parsing, dedupe handoff, and registration-script behavior are otherwise correct
and aligned with current Sendblue docs.

## Findings

### Important

- `src/http/security.ts:13` — Used `req.header(...) === expected` for secret
  validation. Sendblue's documented secret is a literal string, so timing-leak
  attacks on this comparison are theoretically feasible from an attacker that
  can probe the public webhook endpoint. Doc: https://docs.sendblue.com/security
  (signing) and https://docs.sendblue.com/getting-started/webhooks (retry rules
  amplify probe budget — 3 retries x 45s timeout).
  **Fixed**: replaced with `crypto.timingSafeEqual`, equal-length-padded.

- `AGENTS.md:51` — Said "the webhook secret header name is undocumented".
  Stale. Sendblue now documents `sb-signing-secret` on the security page.
  Doc: https://docs.sendblue.com/security
  **Fixed**: AGENTS.md now reflects the documented header and points at
  `docs/features/webhook-security.md`.

- `src/http/app.ts` (multiple routes) — Auth failure responded `401` with a
  static body and no log. Operators chasing a failed Sendblue webhook
  registration would have to reach for tcpdump. Sendblue retries only on 5xx,
  so the 401 itself is correct (we want them not to retry on bad secret), but
  silent rejection is a debuggability gap.
  **Fixed**: structured warn log including route, path, observed
  `sb-`-prefixed header names (not values), remote IP, and user agent.

- No test for invalid-secret on `/webhook/status`, `/webhook/typing-indicator`,
  or operational routes; no test for missing-secret; no test guarding against
  prefix-only secret matches; no test pinning the registered route list.
  **Fixed**: 7 new test cases added in `tests/integration/app-flow.test.ts`.

### Minor

- `src/http/app.ts:148` — typing-indicator parse failures swallowed errors
  silently before responding 400.
  **Fixed**: structured warn log added.

- `src/http/app.ts:99` — receive parse failures returned 400 without logging
  context. Same for operational parse failures around 210.
  **Fixed**: warn logs added on both paths.

- `src/http/app.ts:47` — `createApp` carried no JSDoc, so the response-code
  policy (which is load-bearing for Sendblue retry behavior) lived only in
  AGENTS.md and CLAUDE.md.
  **Fixed**: JSDoc added that pins the per-route status codes against
  Sendblue's documented retry rules.

- `src/http/security.ts` — no JSDoc explaining why we accept two header names
  and why comparison is constant-time.
  **Fixed**: JSDoc added.

### Out of scope (flag only — not edited)

- Body parsing uses `express.json({ limit: '1mb' })` with a `verify` hook that
  captures `rawBody`. There is no explicit content-type rejection. In practice
  `express.json` only parses requests whose content-type matches `application/
  json` (default) so non-JSON requests fall through to handlers with `req.body
  = {}`, which then fails parse with a 400 — acceptable. No change required.
- The receive route returns 502 on chat-endpoint failure (`src/http/app.ts:115`).
  That is a 5xx and would trigger Sendblue retry per docs, but
  `ConversationAgent.handleReceive` already claims the message_handle inside a
  successful path and the chat call itself happens after the 202 response in
  buffered cases — so this 502 fires only when the *synchronous* chat call
  during pre-buffering processing fails. This is intentional per the comment
  in the conversation slice; flagging as a thing to revisit in coordination
  with the conversation slice owner. Per CLAUDE.md "the conversation agent
  does dedupe — verify the route hands off to it for dedupe before doing
  anything irreversible", which it does (dedupe happens first). Not modifying.
- `scripts/e2e/lib/sendblue-webhooks.ts` does not delete stale webhooks — only
  adds or wholesale-replaces. CLAUDE.md only mentions registration; the
  documented Sendblue API supports DELETE on `/api/account/webhooks` so future
  work could add a `--prune` flag. Documented as a known limitation in
  `docs/features/webhook-security.md`; no code change.
- `src/index.ts:81` — autostart gate `process.env.AGENT_AUTOSTART !== '0' &&
  process.env.NODE_ENV !== 'test'` works correctly. Vitest sets `NODE_ENV =
  test` by default and `AGENT_AUTOSTART=0` is honored in dev contexts.
  Verified by inspection only; not edited.

## Fixes Applied

| File | Change | Why |
| --- | --- | --- |
| `src/http/security.ts:1-55` | Switched to `timingSafeEqual` with length-equalization, added JSDoc citing Sendblue's docs. | Prevent timing-side-channel leak of the shared secret; document the contract. |
| `src/http/app.ts:45-77` | Added JSDoc to `createApp` listing routes, response codes, and Sendblue retry rationale. | Pin status-code policy in code so future refactors are forced to read it. |
| `src/http/app.ts` (4 webhook routes) | Added `logSecretRejection(...)` on every `validateWebhookSecret` failure, plus warn logs on parse failures for receive/typing/operational routes. | Operator debuggability for webhook auth and parse errors. |
| `src/http/app.ts:225-242` | New `logSecretRejection` helper that logs route, path, present `sb-*` header names (never values), remote IP, user agent. | Audit-quality logging without leaking the secret. |
| `tests/integration/app-flow.test.ts` | Added 7 cases: missing secret, invalid secret on status / typing / operational routes, prefix-leak guard, malformed status, malformed operational, route pinning. | Lock the security contract against regression. |
| `AGENTS.md:51` | Replaced "undocumented" claim with the now-documented `sb-signing-secret` reference and link. | Keep durable project guidance accurate. |
| `docs/features/webhook-security.md` (new) | Drafted feature doc covering validation, status-code policy, idempotency, registration script, configuration, known limitations. | Per CLAUDE.md docs convention; this is the only feature without a dedicated doc. |

## Missing Test Cases (now added)

All seven previously-missing cases are covered by the new tests in
`tests/integration/app-flow.test.ts`:

- `rejects receive requests with a missing webhook secret` — covers the case
  where Sendblue forgets the header entirely (e.g. webhook reconfigured
  without secret).
- `rejects status callbacks with an invalid webhook secret` — every webhook
  route must enforce the secret, not just `/webhook/receive`.
- `rejects typing-indicator webhooks with an invalid webhook secret` — same
  reason; typing route is account-gated and historically forgotten in tests.
- `rejects operational webhooks with an invalid webhook secret` — guards the
  generic operational handler that mounts on multiple paths.
- `does not constant-time-leak prefix matches when validating the secret` —
  guards against a regression away from `timingSafeEqual`.
- `rejects malformed status payloads with 400` — confirms parse error path
  returns 400 not 5xx.
- `rejects malformed operational payloads with 400` — same for the
  operational generic handler.
- `only registers documented Sendblue webhook paths` — pins the route list so
  any wildcard regression is caught.

## Documentation Updates

- `docs/features/webhook-security.md` (new, ~120 lines) covering: shared-
  secret semantics with quotes from the Sendblue docs, response-code policy
  with retry rationale, idempotency and dedupe handoff, registration script
  modes (`--all`), TLS, configuration variables, and known limitations.
- `AGENTS.md`: corrected the webhook-secret-header guidance to reflect that
  Sendblue now documents `sb-signing-secret`.
- JSDoc added on `createApp` (`src/http/app.ts`) and `validateWebhookSecret`
  (`src/http/security.ts`).

## Open Questions

1. **Will Sendblue ever switch to body-signing HMAC?** Currently the secret is
   a literal string in a header. If they introduce HMAC-SHA256 (or similar)
   over the request body, both `validateWebhookSecret` and `SendblueWebhookClient`
   must change, and the in-memory raw-body capture (`req.rawBody`) becomes
   load-bearing rather than observability-only. There is no signal in the
   public docs that this is planned, but worth a periodic recheck.

2. **Should chat-endpoint failure on the synchronous receive path be 5xx
   instead of 502?** A 5xx would have Sendblue retry. The conversation slice
   owns this trade-off; flagging for cross-slice review with the conversation
   audit (slice 4 or wherever the agent lives).

3. **Should there be a `npm run sendblue:webhooks -- --prune` mode?** The
   current script only adds or replaces. Stale webhooks accumulate over time
   in development accounts. Not a v0.1 concern but worth a v0.4 ticket since
   AGENTS.md lists "webhook registration" under v0.4 ops work.

4. **Is the 401 status code correct for Sendblue?** Per docs, Sendblue retries
   only on 5xx, so 401 will not retry — that is what we want for bad secrets
   (we don't want a misconfiguration to hammer us 4 times). Confirmed
   correct, but worth re-validating from a captured real webhook the first
   time we see it in production logs.
