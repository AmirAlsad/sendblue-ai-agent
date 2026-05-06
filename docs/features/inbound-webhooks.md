# Inbound Webhooks

## What it does

Accepts Sendblue receive, status, typing, and operational webhooks; validates an
optional shared secret; parses and preserves Sendblue payload metadata; dedupes
inbound retries by `message_handle`; and routes direct messages into the
conversation state machine.

## How it works

The Express app exposes these endpoints:

- `GET /health`
- `POST /webhook/receive`
- `POST /webhook/status`
- `POST /webhook/typing-indicator`
- `POST /webhook/call-log`
- `POST /webhook/line-blocked`
- `POST /webhook/line-assigned`
- `POST /webhook/contact-created`

`/webhook/receive` parses required Sendblue fields (`content`, `from_number`,
`to_number`, `message_handle`) plus future-facing metadata such as `service`,
`was_downgraded`, `media_url`, `group_id`, `participants`, `send_style`, and
`message_type`. Unknown fields are preserved under `raw` and are forwarded to
the chat endpoint for direct messages.

Direct messages are keyed as:

```text
direct:{sendblueLine}:{phoneNumber}
```

`sendblueLine` comes from `sendblue_number`, then `to_number`, then
`SENDBLUE_FROM_NUMBER`. The sender phone number comes from `from_number`.

Groups are intentionally silent in v0.2. If `group_id` is present or
`message_type` is `group`, the webhook is acknowledged and deduped, metadata is
available in logs/parser output, and no chat endpoint call or Sendblue reply is
made. Group routing belongs to the v0.4 design.

`/webhook/status` tracks Sendblue outbound lifecycle statuses and advances
ordered delivery queues when the current message reaches the expected
channel-specific gate. `/webhook/typing-indicator` stores inbound typing state
when enabled and does not call the chat endpoint on its own. Other operational
webhooks are parsed generically, logged, and acknowledged for future feature
work.

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

## Known limitations

- Sendblue has no local inbound simulator, so captured real webhooks remain
  important for validating payload shape changes.
- Group messages are not routed to chat or replied to in v0.2.
- Operational webhook handlers currently preserve/log payloads but do not
  trigger product behavior beyond typing state.
- `READ` and `RECEIVED` are not accepted as outbound status callback statuses;
  `RECEIVED` is only valid as an inbound receive payload status.
