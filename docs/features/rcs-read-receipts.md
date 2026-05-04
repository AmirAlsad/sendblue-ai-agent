# RCS / WhatsApp / iMessage Read Receipts

## What it does

Forwards Twilio `read` status callbacks (RCS, WhatsApp, iMessage) to a configurable HTTP URL so your chat endpoint can react to "user has seen the message" events.

## How it works

### RCS-first sending

Outbound SMS messages are sent via `TWILIO_MESSAGING_SERVICE_SID` without an explicit `from` number, allowing Twilio's Messaging Service to select the RCS sender from its pool. If the recipient's device doesn't support RCS, Twilio automatically falls back to SMS using phone-number senders in the pool. WhatsApp messages still use explicit `from` with the `whatsapp:` prefix.

### Read-receipt tracking

When each outbound message is sent via Twilio, a persistent Redis mapping is stored: `readmap:sid:{MessageSid}` → `{userId, timestamp, channel}` with a 72-hour TTL. This mapping survives after the short-lived delivery queue is deleted.

When Twilio delivers a `read` status callback, the status callback handler:

1. Detects `MessageStatus === 'read'` and bypasses the normal delivery queue manager.
2. Looks up the SID mapping in Redis to find the userId and send timestamp.
3. POSTs to `READ_RECEIPT_URL` (if configured) with `{userId, messageTimestamp, readAt, channel}`.
4. Deletes the Redis mapping to prevent duplicate processing.

If `READ_RECEIPT_URL` isn't set, the read event is logged at debug level and dropped.

### Timestamp matching

The send timestamp stored in Redis is captured at Twilio API response time. Your chat endpoint, if matching against its own message history, should expect a small skew (a few seconds) between this timestamp and whatever it stored locally when it returned the messages array. A ±120s tolerance is a reasonable starting point.

## Code files

| File | Role |
| --- | --- |
| `src/utils/twilio-client.js` | Sends messages; omits `from` for SMS to enable RCS-first |
| `src/queue/read-receipt-store.js` | Redis SID→{userId, timestamp} mapping (72h TTL) |
| `src/queue/message-queue-manager.js` | Stores SID mapping after each send (fire-and-forget) |
| `src/routes/status-callback.js` | Handles `read` status, forwards to the configured URL |
| `src/adapters/chat-endpoint-client.js` | `notifyReadReceipt()` — posts to `READ_RECEIPT_URL` |

## Configuration

- `TWILIO_MESSAGING_SERVICE_SID` — required for RCS-first delivery (Messaging Service must include an RCS sender in its pool)
- `STATUS_CALLBACK_URL` — required (Twilio posts read receipts to the same callback URL as delivery callbacks)
- `READ_RECEIPT_URL` — optional; if unset, read events are dropped silently
- `REDIS_URL` — stores the SID mapping

## Dual-use SID mapping

The `readmap:sid:{MessageSid}` Redis mapping is also used by the WhatsApp reply-context feature. When a user swipe-replies to a message, the webhook handler looks up `OriginalRepliedMessageSid` in this same mapping to find the send timestamp. See `whatsapp-typing-and-reply-context.md`.

## Known limitations

- Read receipts only arrive for RCS, WhatsApp, and iMessage. SMS-only users never generate `read` callbacks.
- Users can disable read receipts on their device, in which case no `read` callback is sent.
- The 72-hour Redis TTL means read receipts arriving after 72 hours are silently dropped.
- Twilio does not expose an API to check if a user's device supports RCS; detection is implicit via the `From` field in status callbacks.
- Twilio doesn't expose RCS typing indicators. WhatsApp typing indicators are available via the v2 Indicators endpoint — see `whatsapp-typing-and-reply-context.md`.
