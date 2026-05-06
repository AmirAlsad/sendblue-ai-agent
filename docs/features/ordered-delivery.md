# Ordered Delivery

## What it does

Sends chat endpoint responses through Sendblue one message at a time and waits
for channel-appropriate status callbacks before sending the next queued reply.

## How it works

The chat endpoint can return either a single `message`, an array of `messages`,
or `{ "silence": true }`. Non-empty replies become a per-conversation
`outboundQueue`. The agent sends the current item through Sendblue
`/api/send-message` with a per-message `status_callback` pointing to:

```text
{PUBLIC_BASE_URL}/webhook/status
```

The returned `message_handle` is mapped back to the conversation key so later
status callbacks can advance the correct queue. Redis deployments store that
mapping with `CONVERSATION_TTL_SECONDS`; local/test deployments keep it in
memory.

Sendblue status callbacks are channel-aware:

- iMessage conversations advance on `DELIVERED` (the documented terminal state
  for iMessage).
- SMS and downgraded conversations advance on `SENT` (`SENT` is the terminal
  state for SMS; `DELIVERED` is not reliably emitted).
- RCS conversations advance on `DELIVERED` by default. RCS is treated like
  iMessage for ordering purposes, but Sendblue's public docs do not currently
  cover RCS terminal-state semantics, so this is verified against live captures
  rather than the docs. Adjust if a captured RCS callback shows otherwise.
- `ERROR` and `DECLINED` abort the queue in v0.2.
- Other statuses are tracked but do not advance delivery.

This split matters because SMS may not produce `DELIVERED` in the same way as
iMessage/RCS, while iMessage ordering should wait for delivery confirmation
when available. See
[Sendblue webhooks docs](https://docs.sendblue.com/getting-started/webhooks/)
and [Sendblue send-message docs](https://docs.sendblue.com/getting-started/sending-messages/)
for the underlying status semantics.

Each current outbound handle also gets a local delivery timeout. If the expected
status callback does not arrive before `OUTBOUND_DELIVERY_TIMEOUT_MS`, the agent
advances to the next queued message. This avoids permanently stalled queues when
callbacks are missing or delayed.

If the user sends a new inbound message while the conversation is in `sending`,
the queue is interrupted. The current Sendblue send is left alone, but unsent
queued replies are cancelled and the inbound starts a new buffer.

## Code files

| File | Role |
| --- | --- |
| `src/conversation/agent.ts` | Outbound queue, status gates, interruption, timeout advancement |
| `src/sendblue/client.ts` | Sendblue `send-message` request and required `status_callback` |
| `src/status/tracker.ts` | Status history and terminal status tracking |
| `src/conversation/store.ts` | In-memory outbound handle mapping |
| `src/conversation/redis-store.ts` | Redis outbound handle mapping |
| `src/sendblue/parser.ts` | Status callback validation |

## Configuration

- `PUBLIC_BASE_URL`
- `SENDBLUE_API_BASE_URL`
- `SENDBLUE_API_KEY_ID`
- `SENDBLUE_API_SECRET_KEY`
- `SENDBLUE_FROM_NUMBER`
- `OUTBOUND_DELIVERY_TIMEOUT_MS`
- `CONVERSATION_TTL_SECONDS`

## Known limitations

- v0.2 does not retry failed Sendblue sends or status failures automatically.
- Queue abort on `ERROR`/`DECLINED` currently transitions the conversation to
  `idle` without a fallback message.
- Delivery timeout state is process-local; Redis stores mappings, but active
  JavaScript timers do not survive restarts.
- `READ` is intentionally not used as a delivery gate.
- **RCS terminal-status assumption is unverified.** Sendblue's public docs
  document iMessage→`DELIVERED` and SMS→`SENT` but do not specify RCS
  semantics. This package assumes RCS terminates at `DELIVERED` (matching
  iMessage). If a captured live RCS callback ever terminates at `SENT`, RCS
  queues will stall on the local delivery timeout instead of advancing
  cleanly. Pin against a captured RCS callback before v1.0.
