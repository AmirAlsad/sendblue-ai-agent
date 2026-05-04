# Ordered Delivery

## What it does

Delivers outbound messages sequentially and waits for Twilio delivery confirmations before sending the next message.

## How it works

Outbound responses are queued per user/channel and tracked in Redis. Messages are sent via the Twilio Messaging Service (RCS-first with SMS fallback) with a status callback URL configured. When Twilio posts delivery status updates to `/status/callback`, the queue manager advances to the next message, retries failures, or aborts the queue after max retries or timeouts. Each sent message also gets a persistent SID→{userId, timestamp} mapping stored in Redis (72h TTL) for read receipt tracking — see `rcs-read-receipts.md`.

## Code files

| File | Role |
| --- | --- |
| `src/queue/message-queue-manager.js` | Queue orchestration, retries, and SID mapping writes |
| `src/queue/queue-state.js` | Redis queue storage and message mapping |
| `src/queue/read-receipt-store.js` | Persistent SID→{userId, timestamp} mapping for read receipts |
| `src/routes/status-callback.js` | Twilio status callback handler (delivery + read receipts) |
| `src/queue/strategies/` | Channel-specific delivery rules |

## Configuration

- `STATUS_CALLBACK_URL`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `TWILIO_MESSAGING_SERVICE_SID`
- `REDIS_URL`

## Known limitations

- If `STATUS_CALLBACK_URL` is unreachable, delivery ordering degrades and queues may time out.
- Queue TTLs are fixed in code and may need tuning for long conversations.
