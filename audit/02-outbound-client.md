# Audit 02 — Outbound Sendblue Client

## Summary

`src/sendblue/client.ts` is a thin, intentionally hand-rolled HTTP client
that covers exactly the five endpoints the conversation agent needs
today: `send-message`, `send-group-message`, `send-reaction`,
`mark-read`, `send-typing-indicator`. Auth, base-URL split (v1 `.co`
for send-message, v2 `.com` for the rest), parameter shapes, and the
load-bearing per-message `status_callback` rule all match the docs.

Compared to the official `@sendblue/api` SDK, we are missing
`evaluate-service`, `send-carousel`, `modify-group`,
`upload-media-object`, the v2 `messages` resource, `webhooks` CRUD,
contacts, TOTP, and call-forwarding — none of which are required by
the current feature set, but `evaluate-service` and `modify-group` are
the most likely to matter as v0.4 lands. Conversely, the official SDK
**does not** expose `send-reaction` or `mark-read` even though both
are documented; this package owns them because v0.3 needs them.

The most significant gap I fixed is structured error reporting: the
client previously threw plain `Error` instances on Sendblue failures,
which forced callers to regex the message string. It now throws a new
`SendblueApiError` exposing `operation`, `httpStatus`, `errorCode`,
`serverMessage`, and `responseBody`, while keeping the existing string
message format intact for backward compatibility.

## SDK Comparison Table

| Capability                       | Our client                             | SDK method                            | HTTP endpoint                         | Status |
| -------------------------------- | -------------------------------------- | ------------------------------------- | ------------------------------------- | ------ |
| Send direct message              | `sendMessage`                          | `client.messages.send`                | `POST /api/send-message`              | Covered |
| Get message status               | —                                      | `client.messages.getStatus`           | `GET /api/status`                     | Missing (we use webhooks) |
| List messages                    | —                                      | `client.messages.list`                | `GET /api/v2/messages`                | Missing (out of scope) |
| Retrieve single message          | —                                      | `client.messages.retrieve`            | `GET /api/v2/messages/:id`            | Missing (out of scope) |
| Delete message                   | —                                      | (none in api.md)                      | `DELETE /api/message/:handle`         | Missing (out of scope) |
| Send group message               | `sendGroupMessage`                     | `client.groups.sendMessage`           | `POST /api/send-group-message`        | Covered |
| Modify group (add members)       | —                                      | `client.groups.modify`                | `POST /api/modify-group`              | Missing (v0.4 candidate) |
| Send reaction (Tapback)          | `sendReaction`                         | — (not in SDK)                        | `POST /api/send-reaction`             | Covered (we beat the SDK) |
| Mark read                        | `markRead`                             | — (not in SDK)                        | `POST /api/mark-read`                 | Covered (we beat the SDK) |
| Send typing indicator            | `sendTypingIndicator`                  | `client.typingIndicators.send`        | `POST /api/send-typing-indicator`     | Covered |
| Evaluate service (iMessage check) | —                                     | `client.lookups.lookupNumber`         | `GET /api/evaluate-service`           | Missing (would let us pre-check iMessage instead of relying on `was_downgraded`) |
| Send carousel                    | —                                      | `client.sendCarousel.send`            | `POST /api/send-carousel`             | Missing (richer-media future) |
| Upload media object              | —                                      | `client.mediaObjects.upload`          | `POST /api/upload-media-object`       | Missing (we accept caller-hosted URLs) |
| Contacts CRUD                    | —                                      | `client.contacts.*`                   | `/api/v2/contacts/...`                | Missing (out of scope) |
| Webhook registration CRUD        | One-off scripts                        | `client.webhooks.*`                   | `/api/account/webhooks`               | Missing in `client.ts`; lives in `scripts/e2e/sendblue-webhooks.ts` |
| TOTP                             | —                                      | `client.v2.totp.*`                    | `/api/v2/totp/...`                    | Missing (out of scope) |
| Call forwarding                  | —                                      | `client.lines.callForwarding.*`       | `/api/lines/:n/call-forwarding`       | Missing (out of scope) |

## Findings

### Critical
None.

### Important

1. **Structured error reporting absent (now fixed).**
   File/line: `src/sendblue/client.ts:136` (old `sendblueError`).
   Observed: thrown error was `new Error('Sendblue X failed with Y (...)')`,
   so the conversation agent could not branch on `error_code` (e.g. to
   distinguish `5509` rate-limit from `4002` blacklist). This is
   inconsistent with `src/status/tracker.ts:87-97`, which already
   classifies the documented error codes for *status callbacks*. Sync
   send errors lost that signal.
   Doc URL: https://docs.sendblue.com/api/resources/messages/methods/send/index.md (lists 4000/4001/4002/5000/5003/5509/10001/10002/SMS_LIMIT_REACHED).
   Fix: see "Fixes Applied".

2. **`seat_id` body field on `send-message` not exposed.**
   File/line: `src/sendblue/client.ts:30-36` and
   `src/sendblue/types.ts:99-105` (`SendblueOutboundMessage`).
   Observed: Sendblue's send-message reference documents `seat_id`
   (UUID/Firebase Auth subject) as an optional originator field. We
   never forward it. This matters as soon as anyone deploys with
   multiple seats — outbound attribution will fall back to the
   account default.
   Doc URL: https://docs.sendblue.com/api/resources/messages/methods/send/index.md
   Status: **flagged, not applied** — adding `seatId?: string` to
   `SendblueOutboundMessage` requires editing `src/sendblue/types.ts`,
   which is owned by the inbound-agent slice. Proposed diff:

   ```diff
   // src/sendblue/types.ts
   export type SendblueOutboundMessage = {
     toNumber: string;
     content: string;
     statusCallback: string;
     mediaUrl?: string;
     sendStyle?: SendblueSendStyle;
   + /** Optional Sendblue seat id (UUID or Firebase Auth subject). */
   + seatId?: string;
   };
   ```

   ```diff
   // src/sendblue/client.ts (sendMessage body builder)
     content: message.content,
     status_callback: message.statusCallback,
     ...optionalField('media_url', message.mediaUrl),
   - ...optionalField('send_style', message.sendStyle)
   + ...optionalField('send_style', message.sendStyle),
   + ...optionalField('seat_id', message.seatId)
   ```

3. **`evaluate-service` not implemented; we rely on `was_downgraded`
   as the only iMessage signal.**
   Observed: AGENTS.md treats `was_downgraded` as the canonical
   downgrade signal, which works *after* we have already sent at
   least one message. For new conversations the agent has no way to
   know whether an iMessage-only send effect / reaction will succeed,
   so it sends and lets Sendblue downgrade or 400. Adding
   `evaluateService(number)` would let the agent gate iMessage-only
   actions proactively for cold conversations.
   Doc URL: https://docs.sendblue.com/guides/check-imessage-support
   Status: **flagged, not applied** — this is a v0.3+/v0.4 product
   decision, not a low-risk fix. Note rate limit: 30/h, 100/day per
   line by default.

4. **No retry/backoff for Sendblue server errors.**
   File/line: `src/sendblue/client.ts:113-119` (`postJson`).
   Observed: any `5xx` body produces a `SendblueApiError` and the
   conversation agent (`src/conversation/agent.ts:371`) marks the
   action as failed with `skipReason: 'sendblue action failed'`.
   `5509`/`5003`/`SMS_LIMIT_REACHED` are explicitly *transient* per
   `src/status/tracker.ts:118-126` (`isTransientErrorCode`). At
   minimum the agent should consult `isTransientErrorCode` and retry
   once with a small backoff before skipping.
   Doc URL: https://docs.sendblue.com/api/resources/messages/methods/send/index.md
   Status: **flagged, not applied** — retry policy belongs at the
   agent layer (queue advancement, idempotency around `message_handle`),
   not the client. The client now exposes the right signal via
   `error.errorCode`.

5. **Webhook registration not on the client.**
   Observed: the only place we hit `/api/account/webhooks` is the
   `scripts/e2e/sendblue-webhooks.ts` helper. That's fine for E2E
   bootstrap, but if v0.4 grows operational tooling around dynamic
   webhook registration (per-environment URLs, secret rotation,
   per-account self-service), it should move into a typed method on
   `HttpSendblueClient`.
   Doc URL: https://docs.sendblue.com/getting-started/webhooks/index.md

### Minor

6. **`v1` host vs `v2` host correctness.**
   File/line: `src/config/env.ts:94-95`.
   Observed: defaults are `https://api.sendblue.co` for v1 (used by
   `send-message`) and `https://api.sendblue.com` for v2 (used by
   group/reaction/mark-read/typing/contacts). The Sendblue v2 reference
   page lists *all* endpoints — including `send-message` — under
   `api.sendblue.com`, so it is plausible Sendblue accepts either host
   for `send-message`. The current split matches the per-endpoint
   reference pages and there is no observed problem; just worth
   recording so future readers don't "fix" it.
   Doc URL: https://docs.sendblue.com/api-v2

7. **Group send `status_callback` is silently optional.**
   File/line: `src/sendblue/client.ts:51` (no validation), agent at
   `src/conversation/agent.ts:485-486` always passes one.
   Observed: the client lets `sendGroupMessage` go through without a
   `status_callback`, which is consistent with the docs but means an
   agent bug that loses the URL would degrade silently. Acceptable —
   the agent currently always sets it — but adding a debug-level log
   when missing would make the gap visible.
   Doc URL: https://docs.sendblue.com/getting-started/groups/index.md

8. **No JSDoc on the public surface (now fixed).**
   File/line: `src/sendblue/client.ts:13-19` (interface),
   each method body.
   Observed: no docstrings on `SendblueClient`, `HttpSendblueClient`,
   or any method. This is an open-source-package cosmetic gap that
   makes the contract harder to consume.
   Fix: see "Fixes Applied".

9. **No `docs/features/outbound-client.md` (now fixed).**
   Observed: every other major surface (`inbound-webhooks`,
   `typing-indicators`, `ordered-delivery`, …) has a feature doc. The
   outbound client did not.
   Fix: see "Documentation Updates".

## Fixes Applied

- `src/sendblue/client.ts:23-50` — added `SendblueApiError` exported
  class subclassing `Error`. Carries `operation`, `httpStatus`,
  `errorCode`, `serverMessage`, `responseBody`. Backward-compatible:
  `error instanceof Error` and the existing message format both still
  hold.
- `src/sendblue/client.ts:265-279` (renamed helper) — `sendblueError`
  now returns a `SendblueApiError` instead of a bare `Error`, with the
  same string message. Existing test at
  `tests/unit/sendblue-client.test.ts:211` (regex on the message) still
  passes.
- `src/sendblue/client.ts:1-260` — added JSDoc to the
  `SendblueClient` interface, the `HttpSendblueClient` class, and every
  public method. Each docstring includes the endpoint, base-URL config,
  Sendblue doc URL, body fields, and the relevant `SendblueApiError`
  conditions (rate-limit / blacklist / 4xx etc.).
- `src/index.ts:24` — re-exported `SendblueApiError` so package
  consumers can `import { SendblueApiError } from 'sendblue-ai-agent'`.
- `tests/unit/sendblue-client.test.ts` — added six new test cases
  (see next section).

All changes pass `npm run typecheck` and `npm test` (154 unit + 49
integration).

## Missing Test Cases

Added in this audit:

1. **Structured `SendblueApiError` shape on rate-limited send.**
   Asserts that a 429 with `error_code: "5509"` produces a
   `SendblueApiError` whose `operation`, `httpStatus`, `errorCode`,
   `serverMessage`, and `responseBody` all round-trip. Why it matters:
   the agent retry layer (when added) will branch on `errorCode`.
2. **`SendblueApiError` when the response body is unparseable.**
   Covers the `response.json().catch(() => null)` branch — proves we
   still throw with a useful message and `responseBody === null`
   instead of a `TypeError`.
3. **Group send omits `status_callback` when not provided.**
   Verifies that we don't accidentally serialize an empty string or
   `null` field — important for Sendblue acceptance and matches the
   "optional fields stripped" invariant.
4. **End-to-end base URL routing per endpoint.** Asserts each of the
   five methods hits its expected host (`v1` vs `v2`) so a future
   refactor that consolidates the helper cannot silently swap URLs.
5. **Empty optional fields are stripped before serialization.** Sends
   `mediaUrl: undefined`, `sendStyle: undefined`, `partIndex: undefined`
   and asserts none of `media_url`, `send_style`, `part_index` appear
   in the body. Catches regressions in `optionalField`.
6. **`part_index: 0` is forwarded.** Documented as a valid
   non-negative value; would be lost if the helper used a `Boolean(value)`
   check.
7. **Network/DNS errors propagate without wrapping.** Asserts a
   `TypeError('fetch failed')` rejection passes through, so the agent's
   try/catch sees the underlying cause and does not get a synthetic
   `SendblueApiError` with `httpStatus: 0`.

Still missing (deferred — would touch `src/sendblue/types.ts` or a new
endpoint):

- `seat_id` round-trip on `sendMessage`.
- `evaluate-service` happy-path + rate-limit error.
- `modify-group` add-member call.
- Auth header presence verified independently for every endpoint
  (currently exercised on the v1 send and v2 typing test only).

## Documentation Updates

- `docs/features/outbound-client.md` — drafted. Sections: What it
  does, How it works (auth, base-URL split, status_callback semantics,
  optional fields, error handling, iMessage-only gating boundary),
  Code files, Configuration, Known limitations. Includes the SDK
  comparison and explicitly explains why we *don't* depend on
  `@sendblue/api`.
- `src/sendblue/client.ts` — JSDoc added to `SendblueClient`,
  `HttpSendblueClient`, `SendblueApiError`, and every public method.

## Open Questions

1. **Should `status_callback` ever be optional on `sendMessage`?**
   Sendblue documents it as optional, AGENTS.md mandates it. Worth
   adding a `// safe-mode` overload that allows skipping for one-off
   sends outside the conversation agent (e.g. ops scripts), or do we
   want to keep the throw to prevent foot-guns?

2. **Where does retry/backoff live?**
   `SendblueApiError.errorCode` plus `isTransientErrorCode` from
   `src/status/tracker.ts` are now sufficient to drive a retry policy.
   I did not add one because retries interact with `message_handle`
   tracking, ordered-delivery, and the conversation queue. Open
   question: do we want a policy on the *client* (idempotent retry on
   `5xx`/`5509`/`SMS_LIMIT_REACHED`), on the *agent* (decide-and-retry
   the action), or both?

3. **Add `evaluate-service` for proactive iMessage detection?**
   Would let us avoid sending iMessage-only effects/reactions on a
   first message that turns out to be SMS. The 30/hour rate limit is
   tight; we'd need caching keyed on `phoneNumber` with a TTL. Worth
   a feature ticket separate from this audit.

4. **`v1` vs `v2` send-message host.** Should we test both hosts in
   CI / probe at startup, or trust the docs and the per-endpoint
   reference page? The Sendblue v2 reference lists `send-message`
   under the v2 host as well; the per-endpoint reference still says
   `api.sendblue.co`.

5. **`modify-group` and group operations for v0.4.** When v0.4 lands,
   do we expand `HttpSendblueClient` or factor a separate
   `SendblueGroupOperationsClient`? The current interface is small
   and worth keeping that way.
