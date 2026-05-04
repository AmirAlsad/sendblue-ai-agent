# WhatsApp Typing Indicators and Reply Context

## What it does

Two WhatsApp-specific features:

1. **Typing indicators** — shows a "typing…" bubble and read checkmarks while the chat endpoint is generating a response.
2. **Reply context** — captures WhatsApp swipe-reply metadata (`OriginalRepliedMessageSid`) and forwards it to the chat endpoint as `repliedToSid` / `repliedToSentAt`.

Both features are WhatsApp-only; SMS and RCS flows are unaffected.

## How it works

### Typing indicators

When the buffer timer fires or a trigger begins processing, if the channel is `whatsapp` and a `lastInboundSid` is stored in the conversation state, a fire-and-forget HTTP call is made to the Twilio v2 Indicators API:

```
POST https://messaging.twilio.com/v2/Indicators/Typing.json
Auth: Basic (TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN)
Body: MessageId=<SM-xxx>&Channel=whatsapp
```

This automatically marks the referenced inbound message as read (blue checkmarks) and displays a typing bubble to the user. The bubble disappears when the response is delivered or after 25 seconds.

The `lastInboundSid` is captured from the Twilio webhook body (`MessageSid`) and stored in the Redis conversation state hash. It's updated atomically within the `addToBuffer` and `addToLateArrivals` transactions, and preserved across `transitionToIdle` so it remains available for trigger-originated messages.

For triggers, the typing indicator uses the `lastInboundSid` from the user's most recent inbound message. If the user has never messaged (or the state has expired), no indicator is fired.

### Reply context

When a WhatsApp user swipe-replies to a specific message, Twilio includes `OriginalRepliedMessageSid` in the webhook POST body. The webhook handler:

1. Extracts `OriginalRepliedMessageSid` from `req.body`.
2. Looks up the SID in the read-receipt Redis mapping (`readmap:sid:<SID>`) to get `{userId, timestamp, channel}`.
3. Validates that the `userId` matches the current user (prevents cross-user attribution).
4. Builds a structured buffer item: `{text: "message body", repliedToSid: "SM...", repliedToSentAt: "2026-02-19T..."}`.

When the buffer timer fires, `getAggregatedInput()` extracts the reply context from the first buffer item that has one (if multiple messages are buffered, the earliest swipe-reply wins). The `repliedToSid` and `repliedToSentAt` fields are passed to the chat endpoint alongside the aggregated message text.

Your chat endpoint can then resolve the original message in its own history and decide what to do — annotate the user's message with `[REPLYING TO: "..."]`, surface a UI element, or whatever fits your design.

## Code files

| File | Role |
| --- | --- |
| `src/utils/twilio-typing.js` | HTTP client for Twilio v2 Typing Indicators API |
| `src/routes/webhook-handler.js` | Captures `OriginalRepliedMessageSid`, builds structured buffer items, stores `lastInboundSid` |
| `src/state/conversation-state.js` | `lastInboundSid` field, `setLastInboundSid()`, structured `getAggregatedInput()` |
| `src/timers/buffer-timer-worker.js` | Fires typing indicator, passes reply context to chat endpoint |
| `src/triggers/trigger-processor.js` | Fires typing indicator for trigger-originated messages |
| `src/queue/read-receipt-store.js` | Redis SID mapping used for reply context lookups (shared with read receipts) |

## Configuration

No new env vars required. Uses existing:
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — required for typing-indicator API calls
- `REDIS_URL` — stores `lastInboundSid` in conversation state and read-receipt SID mappings

## Known limitations

- Typing indicators are a Twilio **Public Beta** feature — the API may change before GA and isn't covered by Twilio's SLA.
- Typing indicators aren't HIPAA-eligible or PCI-compliant.
- For trigger-originated messages, the typing indicator uses the user's last inbound MessageSid, which may be stale (hours or days old). Twilio silently ignores expired SIDs — the indicator provides no user value in this case but degrades gracefully.
- Reply context only resolves when the replied-to message is one this package previously sent (with a SID stored in the read-receipt Redis mapping, 72h TTL). Replies to user's own messages or messages older than 72 hours produce no `repliedToSid`.
- If multiple buffer items have reply context (user sends two swipe-replies in rapid succession), only the first one's context is forwarded.
