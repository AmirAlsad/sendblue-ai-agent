# Inbound Webhooks

## What it does

Accepts Sendblue receive, status, documented typing, and operational webhooks;
validates an optional shared secret; parses and preserves Sendblue payload
metadata; dedupes inbound retries by `message_handle`; and routes direct
messages into the conversation state machine.

## How it works

The Express app exposes these endpoints:

- `GET /health` — liveness (uptime, version, node version).
- `GET /ready` — Redis ping + buffer scheduler stats; 503 on dependency failure.
- `GET /metrics` — Prometheus text format, gated by `ADMIN_API_TOKEN`.
- `GET /admin/limits`, `GET /admin/conversations/:key`, `GET /admin/status/:messageHandle`, `GET /admin/queue`, `GET /admin/dedupe?messageHandle=...` — operator introspection, gated by `ADMIN_API_TOKEN`. PII redacted by default; `?reveal=true` unmasks. See `docs/features/operational-visibility.md`.
- `POST /webhook/receive`
- `POST /webhook/status`
- `POST /webhook/typing-indicator`
- `POST /webhook/call-log`
- `POST /webhook/line-blocked`
- `POST /webhook/line-assigned`
- `POST /webhook/contact-created`

A `traceMiddleware` runs ahead of every handler. It accepts an inbound
`x-trace-id` header (well-formed values are reused; otherwise a UUID is
generated), echoes the value back on the response, and stores a pino
child logger plus traceId on `res.locals`. Each webhook route plucks the
`RequestContext` and threads it into the conversation agent so the
traceId surfaces on every log line emitted while processing the request.

`/webhook/receive` requires `from_number`, `to_number`, `message_handle`, and
a string `content` field; the latter may be an empty string because Sendblue
ships media-only inbounds (and some tapback echoes) with `content: ""`.
The parser also surfaces documented Sendblue envelope metadata so that
downstream code does not need to reach into `raw` for routine fields:

- Routing: `service`, `was_downgraded`, `sendblue_number`
- Media and effects: `media_url`, `send_style`
- Group routing: `group_id`, `group_display_name`, `participants`
- Identity: `accountEmail`, `plan`, `opted_out`, `sender_email`, `seat_id`
- Diagnostics: `message_type`, `number`, `date_sent`, `date_updated`
- Error envelope: `error_code`, `error_message`, `error_detail`, `error_reason`

The full original payload is preserved on `raw` and forwarded to the chat
endpoint for direct messages, so unmodeled fields (e.g. future reply or
reaction metadata) remain inspectable without a parser change.

Sendblue does not document a top-level `event_type` discriminator on the
shared message envelope; the route the webhook arrives on is the source of
truth for inbound vs. outbound vs. typing vs. operational. The `call_log`
operational payload is the only event that includes an `event_type` field.

Direct messages are keyed as:

```text
direct:{sendblueLine}:{phoneNumber}
```

`sendblueLine` comes from `sendblue_number`, then `to_number`, then
`SENDBLUE_FROM_NUMBER`. The sender phone number comes from `from_number`.

After dedupe + identity resolution + the optional `validUserRequired`
gate, the agent fires two best-effort hooks:

- **`LimitTracker.recordInbound`** (always on when a tracker is wired)
  bumps the per-line distinct-inbound counter and persists
  `last_inbound_at` for the 24h reply-window classification on outbound.
  See `docs/features/plan-limits.md`.
- **Sendblue contact upsert** (`SENDBLUE_CONTACTS_ENABLED=true`) runs
  fire-and-forget; for direct inbound it upserts the from-number and
  for **invoked, authorized** group inbound it iterates
  `participants[]`. Non-invoked groups and unauthorized invokers return
  early before the upsert hook fires, matching the "groups stay silent
  unless addressed" rule. The upsert never blocks buffering or chat
  dispatch. See `docs/features/contact-upsert.md`.

Groups are address-gated. If `group_id` is present or `message_type` is
`group`, the webhook is acknowledged and deduped. Unaddressed group messages
preserve metadata and stay silent. Addressed groups route only when the message
mentions `AGENT_DISPLAY_NAME`, references a known agent outbound, or future
payloads include explicit reply metadata for the agent.

`/webhook/status` tracks Sendblue outbound lifecycle statuses and advances
ordered delivery queues when the current message reaches the expected
channel-specific gate. The eight documented status values are `REGISTERED`,
`PENDING`, `DECLINED`, `QUEUED`, `ACCEPTED`, `SENT`, `DELIVERED`, and `ERROR`.
`READ` is not a documented status callback, and `RECEIVED` is reserved for
inbound payloads only — both are rejected with a 400 by `parseStatusWebhook`.
The status parser also preserves the message envelope (`from_number`,
`to_number`, `service`, `was_downgraded`, `accountEmail`, `plan`, `group_id`,
`date_sent`, `date_updated`, `error_reason`) for diagnostics.

`/webhook/typing-indicator` stores inbound typing state when enabled and does
not call the chat endpoint on its own. The documented payload includes
`number` (the contact who is typing), `from_number` (the Sendblue line
receiving the indicator), `is_typing`, and an ISO-8601 `timestamp`. Inbound
typing is iMessage-only. This route reflects Sendblue's documented
`typing_indicator` webhook type, but live accounts must verify that the
webhook registration API accepts and persists that type before depending on
inbound typing. Other operational webhooks (`call_log`, `line_blocked`,
`line_assigned`, `contact_created`) are parsed generically, logged, and
acknowledged for future feature work — only `call_log` has a fully documented
field schema upstream; the rest are listed as supported types without payload
specifications.

If `SENDBLUE_WEBHOOK_SECRET` is configured, every webhook route requires either
the configured secret header or `sb-signing-secret` to match. If no secret is
configured, webhook secret validation is skipped.

## Code files

| File | Role |
| --- | --- |
| `src/http/app.ts` | Express routes and response codes |
| `src/http/security.ts` | Shared webhook secret validation |
| `src/sendblue/parser.ts` | Receive, status, typing, and operational parsing |
| `src/sendblue/types.ts` | Sendblue payload and status types |
| `src/sendblue/webhook-types.ts` | Known webhook types and route paths |
| `src/conversation/agent.ts` | Direct/group routing, dedupe, state-machine entry |
| `src/status/tracker.ts` | Status callback history tracking |

## Configuration

- `PUBLIC_BASE_URL` - used to construct outbound `status_callback` URLs.
- `SENDBLUE_WEBHOOK_SECRET` - enables shared secret validation when set.
- `SENDBLUE_WEBHOOK_SECRET_HEADER` - additional accepted secret header name.
- `DEDUPE_TTL_SECONDS` - dedupe window for inbound `message_handle` values.
- `INBOUND_TYPING_STATE_ENABLED` - controls whether typing webhooks update conversation state.
- `AGENT_DISPLAY_NAME` - name used to detect addressed group messages.
- `VALID_USER_REQUIRED` - silently acknowledges unauthorized invokers when enabled.
- `SENDBLUE_CONTACTS_ENABLED` - opts the inbound path into the
  fire-and-forget Sendblue contact upsert hook. See
  `docs/features/contact-upsert.md`.

## Known limitations

- Sendblue has no local inbound simulator, so captured real webhooks remain
  important for validating payload shape changes.
- Group routing is address-gated and beta Sendblue group delivery still needs
  real-line validation.
- Operational webhook handlers currently preserve/log payloads but do not
  trigger product behavior beyond typing state.
- The local `typing_indicator` route and parser are implemented, but real
  inbound typing requires account/API support for registering that webhook type.
  Live testing has observed webhook registration responses that reject or drop
  `typing_indicator` despite the public docs listing it.
- `READ` and `RECEIVED` are not accepted as outbound status callback statuses;
  `RECEIVED` is only valid as an inbound receive payload status.
- Sendblue does not publish payload schemas for `line_blocked`, `line_assigned`,
  or `contact_created`, so the operational parser is intentionally permissive.
  Real captured payloads should be promoted into `tests/fixtures/` (with
  redaction) before tightening these types.
- Inbound `content` may be an empty string when Sendblue ships a media-only
  iMessage. The parser accepts `content: ""` and only rejects when the field
  is missing or non-string; the conversation router treats empty `content`
  combined with a `media_url` as a media inbound.
