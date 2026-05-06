# Slice 01 — Inbound Webhook Parsing

## Summary

The receive/status/typing parsers cover the documented field set well and
correctly reject `READ`/`RECEIVED` as outbound statuses, but several
documented Sendblue envelope fields (`accountEmail`, `plan`, `opted_out`,
`number`, `date_sent`/`date_updated`, `error_reason`, `sender_email`,
`seat_id`) were dropped on the floor — only available via `raw`. The biggest
correctness issue was that `parseReceiveWebhook` rejected payloads with
`content: ""`, which Sendblue legitimately ships for media-only iMessage
inbounds and for some tapback echoes (Sendblue's documented schema specifies
`content: string`, not `string-non-empty`). Both classes of issue are now
fixed and covered by tests; the operational webhook parser remains
intentionally permissive because Sendblue does not publish schemas for
`line_blocked`, `line_assigned`, or `contact_created`.

## Findings

### Critical

- **`src/sendblue/parser.ts:64`** — `content` was required to be non-empty,
  so `parseReceiveWebhook({ content: '', ...})` threw "Missing required
  Sendblue field: content". Sendblue's documented inbound payload uses
  `content: string` (allows `""`); a media-only iMessage or audio/voice
  forward without caption is a documented case. This would have caused
  inbound media to be 400'd by `/webhook/receive`.
  Doc: <https://docs.sendblue.com/getting-started/receiving-messages>

### Important

- **`src/sendblue/types.ts:59-87`** — `SendblueReceiveWebhook` and
  `SendblueStatusWebhook` did not surface several documented envelope fields:
  `accountEmail`, `number`, `plan`, `opted_out`, `date_sent`, `date_updated`,
  `sender_email`, `seat_id`, `error_reason`. AGENTS.md explicitly says "parse
  and preserve future-facing Sendblue fields early, even if v0.1 does not use
  them." These were only reachable via `raw`.
  Doc: <https://docs.sendblue.com/getting-started/webhooks>

- **`src/sendblue/types.ts:89-97`** — `SendblueOperationalWebhook` did not
  surface `event_type`, which the `call_log` webhook ships at the top level
  (`"event_type": "call_log"`). With multiple operational webhook types
  routed through one parser, `event_type` is the only in-payload
  discriminator, so callers had to dip into `raw` to read it.
  Doc: <https://docs.sendblue.com/getting-started/webhooks> (call_log table)

- **`src/sendblue/parser.ts` (`readString`)** — The previous `required` flag
  silently passed empty strings through for non-required fields and threw
  for required ones, which conflated "missing" and "empty". After this audit
  it is split into `required` (must be a string, may be empty) and
  `requireNonEmpty` (must be a non-empty string), which matches what
  Sendblue actually ships and matches the conversation router's needs
  (`from_number`, `to_number`, `message_handle` cannot be empty; `content`
  can be).

### Minor

- **`src/sendblue/parser.ts:74` (group_display_name)** — Used `readString
  ?? null` which collapses `null` and missing to `null` but treats empty
  string as `""`. Documented inbound payloads include `group_display_name:
  null` (non-group) and `group_display_name: ""` (observed group fixtures).
  Adjusted to `readNullableString` so `null` round-trips as `null` and
  `""` round-trips as `""`. No consumer depends on the distinction today,
  but it makes the parser closer to lossless.

- **`src/sendblue/parser.ts` exported parsers** — Had no JSDoc; downstream
  developers had to read implementation to learn that `parseStatusWebhook`
  rejects `READ`/`RECEIVED` or that `parseTypingIndicatorWebhook` is
  account-gated. JSDoc with doc URLs added.

- **Test coverage gaps** — No coverage for non-object payloads, missing
  `message_handle` on status, the full set of documented status values,
  empty `content`, the `error_reason` field, `event_type` on operational
  payloads, missing required fields on typing indicator. All added.

## Fixes Applied

- `src/sendblue/parser.ts:14-71` — Split `readString` into `required` /
  `requireNonEmpty` modes; added `readNullableString`; added JSDoc.
- `src/sendblue/parser.ts:80-127` — `parseReceiveWebhook` now accepts empty
  `content`, requires non-empty `from_number`/`to_number`/`message_handle`,
  and surfaces `accountEmail`, `plan`, `optedOut`, `number`, `dateSent`,
  `dateUpdated`, `senderEmail`, `seatId`, `errorCode`, `errorMessage`,
  `errorDetail`, `errorReason`. Also preserves the
  `null` vs `""` distinction for `groupDisplayName`. Added JSDoc with doc
  URLs.
- `src/sendblue/parser.ts:139-176` — `parseStatusWebhook` requires
  non-empty `message_handle`; surfaces `errorReason`, `fromNumber`,
  `toNumber`, `number`, `accountEmail`, `plan`, `dateSent`, `dateUpdated`,
  `groupId`, `senderEmail`, `seatId`. Added JSDoc.
- `src/sendblue/parser.ts:188-208` — `parseOperationalWebhook` surfaces
  `eventType` (the only in-payload discriminator on `call_log`). Added
  JSDoc explaining why this stays permissive.
- `src/sendblue/parser.ts:218-242` — `parseTypingIndicatorWebhook` now uses
  `requireNonEmpty` for `number` and `from_number`. Added JSDoc with the
  account-gating caveat from AGENTS.md.
- `src/sendblue/types.ts:59-141` — Extended `SendblueReceiveWebhook` /
  `SendblueStatusWebhook` / `SendblueOperationalWebhook` with the new
  optional fields. All additions are purely additive — no consumer of these
  types relies on a closed shape (verified by typecheck + full unit +
  integration test runs).
- `tests/unit/sendblue-parser.test.ts` — Added 14 new tests covering empty
  content, missing identifiers, non-object payloads, all 8 documented status
  values, status-callback envelope metadata, `error_reason`, typing-indicator
  validation, and `call_log`/`event_type`. 28 tests total, all green.
- `docs/features/inbound-webhooks.md` — Documented the actual required
  fields (including `content` empty-string semantics), the surfaced envelope
  metadata, the eight status values and the rejection of `READ`/`RECEIVED`,
  the typing-indicator payload shape and iMessage-only constraint, the
  `event_type` field on `call_log`, and the operational-webhook
  documentation gap upstream.

## Missing Test Cases (none open after this slice)

All test gaps identified during the audit are now covered. Future work that
would add value but is out of scope:

- Real captured fixtures for `line_blocked`, `line_assigned`,
  `contact_created`, and `call_log` operational webhooks. None exist today
  because Sendblue does not publish schemas; capturing live samples would
  let us tighten `SendblueOperationalWebhook` with concrete subtypes.
- Real captured fixture for an inbound typing indicator. The route is
  exercised at the parser level but no observed fixture exists, because
  Sendblue's typing-indicator webhook registration is account-gated and our
  test account has not been observed delivering one (AGENTS.md acknowledges
  this).

## Documentation Updates

- `docs/features/inbound-webhooks.md` — Rewrote the receive section to
  document the actual required-field semantics (including empty `content`),
  added the full surfaced metadata list (routing/media/group/identity/
  diagnostics/error envelope), expanded the status section with all eight
  documented values and the `READ`/`RECEIVED` rejection, added the typing
  indicator payload schema and iMessage-only constraint, and documented the
  upstream gap on `line_blocked`/`line_assigned`/`contact_created` plus the
  empty-content media-only inbound case.

## Open Questions

1. **Reply target metadata.** Sendblue's published inbound schema includes
   no fields like `reply_to_message_handle` or `referenced_message_handle`,
   so contextual replies cannot today be detected from the payload alone.
   `src/conversation/agent.ts:857-885` already does best-effort scanning of
   `raw` for any string keyed `*message_handle*`, `*reply_to*`,
   `*reacted_to*`, `*target*` so that if Sendblue ships these fields in the
   future, addressed-group routing will pick them up automatically. AGENTS.md
   anticipates this but the docs still don't surface a stable contract;
   worth confirming with Sendblue support whether such fields exist on a
   beta/group SKU.

2. **`line_blocked` / `line_assigned` / `contact_created` payload shape.**
   Listed as supported webhook types in
   <https://docs.sendblue.com/getting-started/webhooks> but with no payload
   schema. Until a real example is captured, the operational parser stays
   intentionally generic (only hoists `event_type`, `message_handle`,
   `from_number`, `to_number`, `number`, `status`, `content`).

3. **Webhook secret header name.** `sb-signing-secret` is the implementation
   default. Live captures in `tests/fixtures/sendblue/captured/observed/*`
   confirm Sendblue sends `sb-signing-secret`, but Sendblue does not document
   the header. Out of slice (HTTP/security agent owns it) but worth noting
   alongside the inbound surface.

4. **`event_type` on the message envelope.** `call_log` includes
   `event_type: "call_log"` but `receive`/`outbound` do not. There is no
   uniform discriminator across Sendblue webhook payloads — the URL the
   webhook arrives on is the only consistent signal. Documented this in
   `docs/features/inbound-webhooks.md`.
