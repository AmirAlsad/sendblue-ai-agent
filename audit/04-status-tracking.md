# Audit 04: Status Tracking & Channel-Aware Delivery

## Summary

The status tracker correctly accumulates lifecycle history and treats `DELIVERED`/`DECLINED`/`ERROR` as terminal, but it discarded most of the per-callback Sendblue payload (no per-event log, no `was_downgraded`, no `service`, no `error_reason`, no error categorization). Sendblue's documented status set (8 values) and error code set (9 codes) match `src/sendblue/types.ts`, and the conversation agent's channel-aware advancement rule is implemented correctly (iMessage/RCS on `DELIVERED`, SMS/downgraded on `SENT`). I extended the tracker with a richer event log, sticky downgrade state, and error-code semantic classification, and drafted `docs/features/status-tracking.md`. Two findings need slice-other fixes: the receive parser drops `error_reason`, and the conversation agent does not consume the new `errorCategory` for retry decisions.

## Findings

### Important

1. **`error_reason` is documented but not parsed** — `src/sendblue/parser.ts:96-98` reads `error_code`, `error_message`, `error_detail` but skips `error_reason`. Sendblue documents `error_reason` as a separate field in the status callback payload (see `tests/fixtures/sendblue/status-delivered.json:8` and the captured fixtures under `tests/fixtures/sendblue/captured/observed/*.json`). **This is for the inbound/parser slice to fix.** Doc URL: https://docs.sendblue.com/getting-started/sending-messages
   - Observed: `SendblueStatusWebhook` does not include `errorReason`; parser does not read `payload.error_reason`.
   - Expected: parser should populate `errorReason`, and `SendblueStatusWebhook` (in `src/sendblue/types.ts`) should expose it.
   - The tracker now accepts an optional `errorReason` on the webhook so the wiring will work as soon as the parser slice surfaces the field.

2. **Sendblue's status callback contains many fields we drop on the floor** — `src/sendblue/parser.ts:83-103` only captures `messageHandle`, `status`, error fields, `wasDowngraded`, `service`. Documented payload also includes `accountEmail`, `date_sent`, `date_updated`, `from_number`, `to_number`, `number`, `plan`, `media_url`, `message_type`, `group_id`, `participants`, `send_style`, `opted_out`, `sendblue_number`, `group_display_name`, `content`, `is_outbound`. They survive in `raw` but are not surfaced to consumers. **Parser slice — flag for review.** Doc URL: https://docs.sendblue.com/getting-started/sending-messages
   - The `raw` escape hatch is sufficient for v0.2 because the conversation agent only needs `messageHandle`/`status`/`wasDowngraded`/`service`. Recommend adding `optedOut` (opt-out is conversation-significant for compliance) and `dateUpdated` in a future parser change.

3. **Conversation agent does not differentiate transient vs permanent error codes** — `src/conversation/agent.ts:267-270` aborts the queue on every `ERROR` status. With the new `classifyErrorCode` / `isTransientErrorCode` helpers (and AGENTS.md noting v0.4 will add retries/backoff), transient categories (`rate_limit`, `server`, `sms_limit`, `status_unresolved`) are candidates for retry rather than abort. **Conversation slice fix.** Doc URL: https://docs.sendblue.com/getting-started/sending-messages
   - Today this is correct conservative behavior; flagging because the new tracker exposes the data needed to do better.

### Minor

4. **`SUCCESS` appears as a status in some Sendblue API doc indexes** — In `https://docs.sendblue.com/api-v2/messages/index.md` a 10-row status table includes `SUCCESS` and `RECEIVED` alongside the canonical 8. Confirmed via `https://docs.sendblue.com/getting-started/sending-messages`: the canonical status callback set is exactly the 8 we already have. `SUCCESS` is the API-response status (e.g. `200 { "status": "OK" }` style), not a status callback value, and `RECEIVED` is the inbound payload status. No code change needed; documentation note added in `docs/features/status-tracking.md`.

5. **`SENT` terminality is correctly channel-aware** — `src/conversation/agent.ts:656-658` (`successStatus`) returns `SENT` for SMS/downgraded and `DELIVERED` otherwise. `src/conversation/agent.ts:894-903` (`channelFromStatus`) sets the channel from `was_downgraded`/`service` on the status callback. Behavior matches AGENTS.md. **No change requested.** Doc URL: https://docs.sendblue.com/getting-started/sending-messages

6. **Read receipts: there is no `READ` status callback handling, as required** — A grep of `src/` for `READ` finds only `READ_RECEIPTS_ENABLED` and `READ_RECEIPT_DEBOUNCE_MS` — no inbound handling. `parseStatusWebhook` rejects unknown statuses (`src/sendblue/parser.ts:88-91`). Behavior matches AGENTS.md and the docs. **No change.**

7. **`was_downgraded` end-to-end flow** — Receive parser captures it (`parser.ts:70`); conversation agent applies it via `applyChannel` and sets `state.smsDowngraded` (`agent.ts:720-729`); status callbacks update channel and downgrade flag in `handleStatus` (`agent.ts:264-265`); `successStatus` and `shouldSendReadReceipt`/`shouldSendTypingIndicator` all gate on it. **End-to-end signal is preserved.** The tracker now also keeps `wasDowngraded` sticky on `StatusRecord` so out-of-band consumers do not need to reconstruct it from the conversation record.

8. **Adjacent duplicate dedupe in `history` is correct, but full retry stream was discarded** — Sendblue retries webhooks up to 3x on 5xx with a 45s timeout. Adjacent duplicate entries in `history` are noise, but the tracker previously had no record of how many times a status arrived. Now each callback is appended verbatim to `events[]`. **Fixed.**

## Fixes Applied

- `src/status/tracker.ts:1-end` — Replaced module while preserving the existing exports (`StatusRecord`, `TERMINAL_STATUSES`, `createStatusRecord`, `applyStatusUpdate`, `InMemoryStatusStore`).
  - Added `events: StatusEvent[]` to `StatusRecord` to preserve every Sendblue callback payload (status, error fields, `wasDowngraded`, `service`, `receivedAt`).
  - Added `errorReason`, `errorCategory`, `wasDowngraded` (sticky), `service`, `lastService`, `lastUpdatedAt` to `StatusRecord` so consumers do not have to re-parse callbacks.
  - Added `classifyErrorCode`, `isTransientErrorCode`, `isDocumentedErrorCode`, `ErrorCodeCategory`. Mapping derived from https://docs.sendblue.com/getting-started/sending-messages.
  - Added JSDoc on every export explaining intent, terminality semantics, and the deliberate exclusion of `READ`.
  - `applyStatusUpdate` is now explicitly pure and accepts an optional `now` injection for deterministic tests.
  - Why: the tracker used to drop most of the callback payload. Operational consumers (retry workers, dashboards, group routing) need the per-callback timeline and the semantic error category.

- `tests/unit/status-tracker.test.ts:1-end` — Expanded from 3 to 20 tests across 3 describe blocks. New coverage:
  - Full 8-status lifecycle walkthrough.
  - Per-callback `events[]` preservation under retry.
  - `error_reason` capture and category classification.
  - `DECLINED` terminal behavior.
  - `SENT` non-terminal at tracker layer (channel-aware terminality is the agent's job).
  - Sticky `wasDowngraded` across callbacks where later callbacks omit the field.
  - `service` per-event vs first-observed vs last-observed.
  - `receivedAt` timestamp injection.
  - Input-record immutability.
  - `ERROR` → late `QUEUED` callback does not lose terminality.
  - `classifyErrorCode` against every documented code (numeric and named, plus undocumented and `null`/`undefined`).
  - `isTransientErrorCode` and `isDocumentedErrorCode` behavior.
  - `InMemoryStatusStore` independence per `message_handle` and `clear()`.

- `docs/features/status-tracking.md` — New file. Documents what status tracking does, the 8 documented Sendblue statuses, the explicit absence of `READ`, the error code classification table with doc-cited meanings, the channel-aware advancement rule (and that it lives in the conversation agent, not here), code-file map, configuration, and known limitations.

## Missing Test Cases

The tracker tests are now comprehensive for this slice. Missing coverage that lives outside my slice:

1. **Conversation agent: status-driven advancement for `RCS` channel** — `successStatus` returns `DELIVERED` for non-SMS channels including RCS, but I did not find a unit test that drives `handleStatus` for an RCS conversation specifically. **Conversation slice.**

2. **Conversation agent: `was_downgraded` toggling mid-flight** — A scenario where the first send is `iMessage` but the second send (after downgrade) advances on `SENT` rather than `DELIVERED`. **Conversation slice.**

3. **Conversation agent: `ERROR` with each documented error code** — Today `handleStatus` aborts on any `ERROR`. When retry semantics land, exercise transient codes (`5000`, `5509`, `SMS_LIMIT_REACHED`) vs permanent codes (`4000`, `4002`). **Conversation slice (future).**

4. **Parser: malformed status payload handling** — `parseStatusWebhook` throws on `payload` not being an object or on missing/invalid status. Worth a unit test for an unknown status string round-trip; if `parseSendblueStatus` returns undefined, parser throws "Missing or invalid Sendblue status" — fine, but no test asserts that specifically. **Parser slice.**

5. **Parser: `error_reason` parsing** — Cannot be added until the parser captures the field. **Parser slice.**

## Documentation Updates

- `docs/features/status-tracking.md` (new) — Drafted per the project doc format. Covers all 8 statuses with terminality, all 9 error codes with semantic categories and doc citations, the deliberate non-existence of `READ` callbacks, the channel-aware advancement rule (with pointer to `ordered-delivery.md` for the agent-side details), and known limitations (in-memory tracker, parser gap on `error_reason`).
- `src/status/tracker.ts` — Added JSDoc on every exported symbol, including doc-anchored citations (e.g. "8 documented Sendblue status values", "READ is intentionally not part of this lifecycle").

No edits to `docs/features/ordered-delivery.md` — it's owned by the conversation slice and remains accurate for the queue-advancement story.

## Open Questions

1. **Is `errorCategory: 'unknown'` the right default for codes Sendblue emits but we don't enumerate?** Today we silently classify them as `unknown`. Alternative: log a warning so we notice new codes Sendblue ships. Probably worth a follow-up.

2. **Should `applyStatusUpdate` reject (or warn on) status updates that arrive after a terminal status?** The current behavior accepts them and appends to `events[]` while keeping `terminalStatus` pinned. This is the most forgiving option for retried webhooks and re-deliveries, but a stricter mode might catch backend bugs sooner.

3. **Is the per-handle `events[]` log suitable for production scale?** Today it's bounded by the number of status callbacks per outbound message (typically <10). With Redis persistence (a future change) we'd want a max length to bound state size. Not blocking for v0.2.

4. **How should `opted_out` flow through the system?** Sendblue documents it on every status callback. The conversation slice will eventually want this for compliance gating, but neither parser nor agent surfaces it today. **Parser slice.**

5. **Is `SUCCESS` ever emitted as a status callback in practice?** The doc index lists it but the canonical sending-messages page does not. Captured fixtures show only `DELIVERED`. Worth a live capture session before we add it to `SENDBLUE_STATUSES`.
