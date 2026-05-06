# Status Tracking

## What it does

Accumulates Sendblue outbound message status callbacks per `message_handle`,
maintains a deduplicated lifecycle history, captures full per-callback events
for diagnostics, and classifies error codes into semantic categories so the
conversation agent and operational consumers can react without re-parsing the
raw payload.

This module is the data-shape layer for status. The runtime decision of
*when to advance an outbound queue* is owned by the conversation agent
(`src/conversation/agent.ts`) and is documented in
`docs/features/ordered-delivery.md`.

## How it works

`POST /webhook/status` parses the Sendblue status callback through
`parseStatusWebhook` and hands the result to `InMemoryStatusStore.apply`,
which calls `applyStatusUpdate(existing, update)` and persists the new record.

`applyStatusUpdate` is pure — it never mutates the input — and produces a
record with:

- `history: SendblueStatus[]` — adjacent duplicate statuses are skipped so
  the lifecycle is readable. Sendblue retries webhooks up to 3 times on 5xx
  responses; adjacent duplicates are noise rather than signal.
- `events: StatusEvent[]` — every callback is appended verbatim
  (`status`, `errorCode`, `errorMessage`, `errorDetail`, `errorReason`,
  `wasDowngraded`, `service`, `receivedAt`). Operational dashboards and
  retry workers should read from `events`, not `history`.
- `terminalStatus` — set when the status is one of `DELIVERED`, `DECLINED`,
  or `ERROR`. `SENT` is intentionally not treated as terminal at this
  layer because terminality for `SENT` is channel-aware (SMS/downgraded)
  and that decision lives in the conversation agent.
- `wasDowngraded` — sticky once observed as `true`. AGENTS.md treats
  `was_downgraded` as conversation-significant state, so the tracker
  preserves it even if a later callback omits the field.
- `service`, `lastService` — the first-observed and most-recent service
  string (`iMessage`, `SMS`, `RCS`).
- `errorCode`, `errorMessage`, `errorDetail`, `errorReason`,
  `errorCategory` — captured on terminal `ERROR` status. The category is
  produced by `classifyErrorCode`.

### Documented Sendblue status callback values

Sendblue documents exactly **eight** status callback values:

| Status     | Meaning                          | Terminal at tracker layer |
| ---------- | -------------------------------- | ------------------------- |
| REGISTERED | Registered in system             | no                        |
| PENDING    | Being processed                  | no                        |
| QUEUED     | Waiting to send                  | no                        |
| ACCEPTED   | Accepted for processing          | no                        |
| SENT       | Sent to carrier                  | no (channel-aware)        |
| DELIVERED  | Delivered to device              | yes                       |
| DECLINED   | Message rejected                 | yes                       |
| ERROR      | Delivery failed                  | yes                       |

`READ` is **not** a Sendblue status callback. Read receipts are an
outbound `POST /api/mark-read` action. Treat any inbound `READ` as
unknown and ignore it — the parser will reject it.

`RECEIVED` is only valid as an inbound `receive` payload status, not a
status callback. The parser already enforces that distinction.

### Error code categories

`classifyErrorCode(code)` maps every documented Sendblue error code to
one of: `validation`, `rate_limit`, `blacklist`, `server`, `send_failed`,
`status_unresolved`, `sms_limit`, `unknown`.

| Code               | Category          | Sendblue meaning                                     |
| ------------------ | ----------------- | ---------------------------------------------------- |
| 4000               | validation        | Validation Error — see `error_message`               |
| 4001               | rate_limit        | Rate Limit Exceeded                                  |
| 4002               | blacklist         | Blacklisted Number (e.g. 911)                        |
| 5000               | server            | Internal Error                                       |
| 5003               | rate_limit        | Server Rate Exceeded                                 |
| 5509               | rate_limit        | Rate-limit window exceeded                           |
| 10001              | send_failed       | Message failed to send                               |
| 10002              | status_unresolved | Failed to resolve message status                     |
| SMS_LIMIT_REACHED  | sms_limit         | Sendblue internal SMS limit                          |

`isTransientErrorCode(code)` returns `true` for `rate_limit`, `server`,
`sms_limit`, and `status_unresolved` — useful for any caller deciding
whether to retry rather than abort. `isDocumentedErrorCode(code)` is a
type guard for the documented enumeration in `src/sendblue/types.ts`.

Note: Sendblue documents `error_code` as `int` for numeric codes;
`classifyErrorCode` accepts both numeric and string values.

### Channel-aware queue advancement (owner: conversation agent)

The conversation agent advances outbound queues on different statuses
depending on the channel:

- iMessage and RCS conversations advance on `DELIVERED`.
- SMS and downgraded (`was_downgraded === true`) conversations advance on
  `SENT`.
- `ERROR` and `DECLINED` abort the queue (v0.2 behavior).

This rule is implemented in `ConversationAgent.handleStatus` and
`ConversationAgent.successStatus`. The status tracker does not encode
channel-aware terminality.

### Read receipts (no `READ` callback)

Read receipts are a separate outbound API call:

- `POST /api/mark-read` with `{ number, from_number }` (E.164 format)
- Best-effort: there is no callback confirming the recipient saw the
  read receipt
- Account-gated: must be enabled by Sendblue engineering
- iMessage/RCS only

The package wires read receipts through `SendblueClient.markRead` and
`ConversationAgent.maybeSendReadReceipt`, gated by
`READ_RECEIPTS_ENABLED`. There is no status-tracker behavior for read
receipts and there must not be — Sendblue does not send a `READ` callback.

## Code files

| File | Role |
| --- | --- |
| `src/status/tracker.ts` | `applyStatusUpdate`, `InMemoryStatusStore`, `classifyErrorCode`, `isTransientErrorCode`, `TERMINAL_STATUSES` |
| `src/sendblue/types.ts` | `SendblueStatus`, `SendblueErrorCode`, `SendblueStatusWebhook` |
| `src/sendblue/parser.ts` | `parseStatusWebhook` — payload validation |
| `src/conversation/agent.ts` | Channel-aware queue advancement on status callbacks |
| `src/conversation/store.ts` / `redis-store.ts` | `getOutboundHandleMapping` for routing status callbacks back to a conversation |
| `tests/unit/status-tracker.test.ts` | Lifecycle, dedupe, error classification, downgrade stickiness |
| `tests/fixtures/sendblue/status-delivered.json` | Captured DELIVERED payload shape |

## Configuration

- `PUBLIC_BASE_URL` — used to construct outbound `status_callback` URLs.
- `OUTBOUND_DELIVERY_TIMEOUT_MS` — local fallback when the expected
  channel-appropriate callback never arrives.
- `READ_RECEIPTS_ENABLED` — gates the separate read-receipt API call;
  unrelated to status callbacks.

## Known limitations

- The status tracker is in-memory. Per-handle records are not persisted
  to Redis; only the outbound handle → conversation key mapping is. If
  the process restarts mid-flight, status `events` history is lost
  (history-driven advancement still works because the agent persists
  conversation state separately).
- The Sendblue status callback payload includes `error_reason`, but the
  receive parser (`src/sendblue/parser.ts`) does not currently surface
  it. The tracker accepts `errorReason` if present and falls back to
  `undefined` otherwise. Adding parser support is a parser-slice change.
- The webhook secret header name is undocumented. The parser/security
  layer accepts a configurable header (`SENDBLUE_WEBHOOK_SECRET_HEADER`,
  default `sb-signing-secret`) and is unrelated to status tracking.
- Sendblue retries webhook delivery up to 3 times on 5xx responses with
  a 45-second timeout. Dedupe lives in the inbound path
  (`message_handle`); the status tracker dedupes adjacent duplicates in
  `history` but always preserves them in `events`.
