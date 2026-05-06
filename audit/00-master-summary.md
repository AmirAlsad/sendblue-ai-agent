# Sendblue AI Agent — Audit Master Summary

> Seven parallel Opus audits, 2026-05-06.
> Slice reports: [01](./01-inbound-webhooks.md) · [02](./02-outbound-client.md) · [03](./03-conversation-agent.md) · [04](./04-status-tracking.md) · [05](./05-chat-contract.md) · [06](./06-http-and-security.md) · [07](./07-identity-config-docs.md)

## Executive summary

The Sendblue transport surface is implemented competently and largely matches
the docs as they stand today. The audit landed two real correctness fixes
(receive-parser 400ing legitimate empty-content media inbounds; iMessage-only
rich actions leaking onto SMS/downgraded conversations), one real security fix
(non-constant-time webhook secret compare), one real availability fix (no
timeout on the inline identity resolver), one operability upgrade (structured
`SendblueApiError`), and a substantial documentation refresh. Sendblue has
*meanwhile* documented one previously-undocumented thing
(`sb-signing-secret` as the literal webhook header) — `AGENTS.md` corrected.

After all parallel edits: **`npm run typecheck` clean · 159 unit + 49
integration tests pass · 31 source/test/doc files modified · 4 new files
created (3 feature docs + 1 audit set).**

> **Update — closeout pass.** All P1 and P2 follow-ups from the original
> "high-priority open follow-ups" table below have landed, plus three of
> the P3/P4 items. Final state after closeout: **`npm run typecheck`
> clean · 163 unit + 53 integration = 216 tests pass · 4 additional
> feature docs drafted (`inbound-dedupe.md`, `scheduler.md`,
> `persistence.md`, `group-routing.md`).** See "Closeout (post-audit
> follow-ups)" section near the end of this document.

## What landed (per-slice highlights)

| Slice | What changed | Impact |
| --- | --- | --- |
| 01 inbound parsing | `parseReceiveWebhook` accepts empty `content` (media-only iMessage); 8+ envelope fields surfaced (`accountEmail`, `optedOut`, `errorReason`, `dateUpdated`, `seatId`, …); `event_type` hoisted on operational; JSDoc on every parser; +14 tests (28 total) | **Critical correctness fix** — previously 400'd legitimate Sendblue webhooks |
| 02 outbound client | New `SendblueApiError` carries `operation`, `httpStatus`, `errorCode`, `serverMessage`, `responseBody`; full JSDoc; +6 tests (14 total); SDK comparison table | Operability upgrade — callers no longer regex error strings |
| 03 conversation agent | Read receipts gated to iMessage; reactions skipped on SMS/downgraded; `sendStyle` dropped on SMS/downgraded; +5 integration tests; 3 feature docs refreshed | iMessage-only rich-action leaks plugged (but see Conflict #1 below) |
| 04 status tracking | Tracker now logs every callback in `events[]`, sticky `wasDowngraded`, `service`/`lastService`, `errorReason`, `errorCategory`; new helpers `classifyErrorCode` / `isTransientErrorCode` / `isDocumentedErrorCode`; +17 tests (20 total) | Status payloads were silently dropped — now preserved & classified |
| 05 chat contract | Removed dead duplicate `resolveTargetRef`; widened `TargetRef.alias` literal to all 8 spellings the resolver accepts; new `IMESSAGE_ONLY_ACTION_TYPES` constant; +18 tests (42 total); rich-actions doc rewritten with canonical Sendblue values + URLs | Type accuracy + dead-code removal |
| 06 HTTP & security | `crypto.timingSafeEqual` replaces `===` for secret compare; structured auth-failure logs (route, path, header names, IP, UA — never values); JSDoc on `createApp` pinning Sendblue retry-aware status codes; +7 tests; drafted `webhook-security.md`; **AGENTS.md corrected** for `sb-signing-secret` | **Real security fix** + Sendblue docs caught up to AGENTS.md |
| 07 identity/config/docs | `IDENTITY_RESOLVER_TIMEOUT_MS` (default 5s) — closes a real availability hole; clearer error on bad JSON; +9 identity tests (11 total) and +6 config tests (10 total); `configuration.md` and `identity-resolver.md` refreshed | **Real availability fix** — hung lookup would have stalled buffering |

## New feature docs

- `docs/features/outbound-client.md` (slice 2)
- `docs/features/status-tracking.md` (slice 4)
- `docs/features/webhook-security.md` (slice 6)

Refreshed: `inbound-webhooks.md`, `conversation-state.md`, `ordered-delivery.md`, `message-buffering.md`, `rich-chat-actions.md`, `configuration.md`, `identity-resolver.md`.

## Cross-cutting resolutions (closed in-flight)

- **`error_reason` parsing** — slice 4 flagged that the status parser dropped this; slice 1 surfaced it. ✓ Closed.
- **`logSecretRejection` undefined** — slice 3 noted a transient typecheck breakage; slice 6 landed the helper definition. ✓ Closed.
- **AGENTS.md webhook-signing claim outdated** — slice 6 corrected. ✓ Closed.

## Conflicts and inconsistencies (need your decision)

### Conflict 1 — Read receipts on RCS (FACTUAL CONTRADICTION between slices)

Slice 3 (conversation) **tightened** `shouldSendReadReceipt` to `channel === 'imessage'` only, citing `AGENTS.md` "iMessage-only rich actions".

Slice 5 (chat) **flagged this as wrong**, citing
<https://docs.sendblue.com/api-v2/read-receipts/>:
> "Read receipts work for iMessage and RCS conversations, not SMS."

Slice 5 wins on factual accuracy. AGENTS.md's wording was over-broad — it
collapsed "iMessage-only" rules across reactions/effects/typing (which truly
are iMessage-only) and read receipts (which are iMessage **and** RCS).

**Recommended fix:** revert `shouldSendReadReceipt` to `channel === 'imessage' || channel === 'rcs'` (still excluding SMS and downgraded), update the matching test, and tighten AGENTS.md to break out the per-feature support matrix instead of one blanket rule.

### Conflict 2 — `was_downgraded` lifecycle (semantic ambiguity)

`AGENTS.md` calls `was_downgraded` "conversation-significant state". Slice 3
notes the agent currently *clears* `smsDowngraded` when a fresh `service: "iMessage"` receive arrives (intuitive UX) but `AGENTS.md` could equally be read to mean "once downgraded, sticky for the conversation's life". Pin the rule in `AGENTS.md`.

### Conflict 3 — RCS terminal status

Slice 3 / slice 4 both note: agent advances RCS queues on `DELIVERED`, but Sendblue's public docs only confirm iMessage→`DELIVERED` and SMS→`SENT`. The RCS-on-`DELIVERED` treatment is an *internal default* not a documented Sendblue contract. Worth a captured live RCS run before v1.0.

## High-priority open follow-ups

These were flagged across slices but **not applied** (cross-cutting, behavioral, or out of an audit slice's scope):

| Pri | Item | Origin | Cost | Why it matters |
| --- | --- | --- | --- | --- |
| P1 | Resolve Conflict 1 (read receipts on RCS) | slices 3 + 5 | 1 line + 1 test + AGENTS.md wording | We're dropping legitimate RCS read receipts that Sendblue supports |
| P1 | Add `seat_id` to `SendblueOutboundMessage` + forward in `sendMessage` | slice 2 | ~5 lines, exact diff in `audit/02` | Multi-seat deployments lose outbound attribution today |
| P2 | Apply slice 7's AGENTS.md proposed diffs (6 wording changes) | slice 7 | doc-only, see `audit/07` §"AGENTS.md Proposed Diffs" | Closes 5 doc-source-of-truth gaps + 1 fail-open clarification |
| P2 | Decide and document `was_downgraded` lifecycle (Conflict 2) | slice 3 | doc + maybe 1 line | Today's behavior is defensible; ambiguity is the problem |
| P2 | Differentiate transient vs permanent `ERROR` codes in `handleStatus` (use new `classifyErrorCode`) | slice 4 | small refactor in `agent.ts` + tests | Foundation for v0.4 retry/backoff |
| P3 | Tighten group-invocation "delivered message content substring" heuristic | slice 3 | needs a config knob (e.g. `GROUP_INVOCATION_CONTENT_FALLBACK`) | Short agent replies (`"yes"`) cause false-positive group invocations |
| P3 | Decide where Sendblue retry policy lives (client / agent / both) for transient codes (`5509`, `5003`, `SMS_LIMIT_REACHED`) | slices 2 + 4 | design decision, then implementation | New `SendblueApiError.errorCode` + `isTransientErrorCode` make this implementable |
| P3 | Capture live RCS callback to confirm RCS terminal status (Conflict 3) | slices 3 + 4 | manual E2E session | Currently a guess that happens to work |
| P4 | Add `evaluate-service` to outbound client for proactive iMessage detection | slice 2 | new method + caching layer | Lets v0.4+ gate iMessage-only effects on cold conversations instead of failing-then-degrading |
| P4 | Add `--prune` mode to `npm run sendblue:webhooks` | slice 6 | small script change | Stale dev-account webhooks accumulate today |
| P4 | Outbound-handle → conversation-key map cleanup on `advanceQueue` / `transitionToIdle` | slice 3 | small Redis cleanup | Benign Redis stale-key build-up; TTL handles eventually |

## Documentation gap inventory

Slice 7 catalogued 6 modules without dedicated `docs/features/` pages.
Three were drafted in this audit (outbound-client, status-tracking,
webhook-security). Three remain:

- **Inbound dedupe** (`message_handle`, `DEDUPE_TTL_SECONDS`, `SET NX`)
- **Scheduler / BullMQ** (`src/conversation/scheduler.ts`)
- **Persistence / Redis store** (key formats, TTL strategy, outbound-handle map)
- **Group routing** (could promote from being scattered across `inbound-webhooks.md` and `conversation-state.md` — slice 7 also flagged this)

## Verification

```
npm run typecheck   # clean
npm test            # 159 unit + 49 integration = 208 tests, all pass
git status          # 31 files modified, 4 new (3 docs + audit/)
```

No edit conflicts despite 7 parallel agents — strict ownership boundaries
held. The only cross-slice transient was `logSecretRejection` (slice 3 saw an
undefined symbol mid-flight; slice 6 landed the definition before either
finished).

## Post-audit follow-ups (applied)

The five "Recommended next session" items below were all applied in the
follow-up session (2026-05-06). See per-item status:

| # | Item | Status |
| --- | --- | --- |
| 1 | RCS read receipts (Conflict 1) | ✅ Applied — `agent.ts` widened to `imessage \|\| rcs`, integration test flipped + added SMS-suppression test |
| 2 | `seat_id` field on `SendblueOutboundMessage` | ✅ Applied — type + client + 2 round-trip tests |
| 3 | Slice 7 AGENTS.md wording diffs (6) | ✅ Applied |
| 4 | `was_downgraded` lifecycle pinned | ✅ Documented in AGENTS.md as "clears when fresh iMessage receive arrives" + integration test for the iMessage→SMS-downgrade→iMessage cycle |
| 5 | RCS terminal-status assumption | ✅ TODO comment near `successStatus`, "Known limitations" entry in `ordered-delivery.md` (live RCS capture still needed before v1.0) |

**Bonus finding from the post-audit live-test session:** `mark-read` re-test
exposed a `++<digits>` typo in the deployment's `.env` and led to adding
**E.164 validation in `loadConfig`** so the next typo fails fast at startup
rather than silently 400ing. Documented in `audit/08-sendblue-support-email.md`.

A new diagnostic `npm run probe:sendblue` (`scripts/e2e/probe-sendblue.ts`)
was also added — one-shot live `mark-read` call useful after Sendblue support
enables the read-receipt feature on an account.

## Recommended next session

1. Apply Conflict 1 fix (RCS read receipts) — 5 minutes including test.
2. Apply slice 2's `seat_id` diff — 5 minutes.
3. Walk through slice 7's AGENTS.md proposed diffs and apply the ones you agree with — 15 minutes.
4. Decide on Conflict 2 wording (sticky vs clearable `was_downgraded`).
5. Schedule a live RCS capture session to settle Conflict 3 before v1.0.
6. Defer the retry-policy / `evaluate-service` / persistence-doc work to v0.4 planning.

---

## Closeout (post-audit follow-ups)

After the user accepted the master summary, the following landed in two
follow-up passes. Tests/typecheck are green at every step (final: 163
unit + 53 integration = 216 tests).

### Pass 1 — P1/P2 fixes (all 5 applied)

| Item | What landed |
| --- | --- |
| **Conflict 1: RCS read receipts** | Reverted `shouldSendReadReceipt` to allow iMessage AND RCS (still excluding SMS/downgraded) per Sendblue's read-receipts docs. Flipped the existing RCS suppression test into a positive assertion + added explicit SMS/downgraded suppression test. AGENTS.md "iMessage-only rich actions" rewritten as a per-feature support matrix that makes the iMessage+RCS exception explicit. |
| **`seat_id` field add** | `seatId?: string` added to `SendblueOutboundMessage`; forwarded via `optionalField('seat_id', ...)` in `HttpSendblueClient.sendMessage`; +2 round-trip tests. Stale audit-comment in `client.ts` removed. |
| **Slice 7 AGENTS.md diffs** | All 6 wording changes applied: identity fail-open clarification (catch lives in agent), inline-blocking-call timeout rule, Sendblue Contacts v2 stance, SDK env-var naming note, doc-coverage expectations, explicit no-`READ`-callback statement. |
| **Conflict 2: `was_downgraded` lifecycle** | Pinned in AGENTS.md: `smsDowngraded` clears when a fresh `service: "iMessage"` payload arrives (intentional UX, not sticky-for-life). Locked in by an integration test that exercises iMessage→SMS-downgrade→iMessage and asserts the clear. |
| **Conflict 3: RCS terminal status** | Surfaced as inline TODO comment near `successStatus` and a "Known limitations" entry in `ordered-delivery.md` flagging the unverified RCS-on-`DELIVERED` assumption. (Live capture is a manual action; left for the user.) |

### Pass 2 — P3/P4 items executed

| Item | What landed |
| --- | --- |
| **Group-invocation content-fallback knob** | New `GROUP_INVOCATION_CONTENT_FALLBACK` config (default `true` for backward compatibility). When `false`, the substring-of-prior-agent-message heuristic is skipped — only `@AGENT_DISPLAY_NAME` mentions and reply-metadata references count as addressing. +2 integration tests covering both modes; documented in `docs/features/group-routing.md`. |
| **Outbound-handle map cleanup on advance** | `advanceQueue` now deletes the just-completed `messageHandle`'s mapping; `transitionToIdle` defensively deletes any still-attached handle. Stale Redis keys no longer accumulate to `CONVERSATION_TTL_SECONDS`. |
| **4 missing feature docs drafted** | `docs/features/inbound-dedupe.md`, `docs/features/scheduler.md`, `docs/features/persistence.md`, `docs/features/group-routing.md`. Closes out slice 7's documentation coverage map; `docs/features/` now covers every load-bearing module. |

### Pass 2 — items deliberately deferred

| Item | Why deferred |
| --- | --- |
| **Retry policy for transient Sendblue errors** | Genuine design decision (client-level idempotent retry vs agent-level decide-and-retry vs both). The new `SendblueApiError.errorCode` and `isTransientErrorCode` from this audit make either approach implementable. Adding retry semantics affects `message_handle` tracking, status_callback ordering, and queue advancement — wrong default would create load-bearing semantics that are hard to roll back. Still open for explicit product decision. |
| **`evaluate-service` for proactive iMessage detection** | New endpoint with a 30/h × 100/day per-line rate limit per Sendblue docs. Implementing safely requires a caching layer keyed on phone number with a TTL, and a product decision on whether to gate iMessage-only actions on cold conversations. v0.3+/v0.4 territory — not executable without explicit scope. |
| **`--prune` mode for `npm run sendblue:webhooks`** | Slice 6 explicitly flagged this as a "v0.4 ticket" and would require a Sendblue webhook-CRUD endpoint not currently used by the package. Clear ops value but out of audit scope. |
| **Live RCS callback capture** | Manual macOS/iMessage E2E session — cannot be performed automatically. The unverified-assumption note in code + docs surfaces this for the user. |

### Final state

- **Source/tests/docs modified:** 33+ files
- **New files:** 8 (1 master + 7 slice audit reports, plus 7 new feature docs across the audit and closeout)
- **Tests:** 163 unit + 53 integration = 216 (was 107 before audit)
- **Typecheck:** clean
- **No edit conflicts** despite 7 parallel agents and two sequential closeout passes.
