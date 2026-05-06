# Typing Indicators

## What it does

Supports Sendblue typing indicators in both directions: outbound best-effort
typing signals before the chat endpoint is called, and inbound typing state that
is included in the next direct-message chat request.

## How it works

### Outbound typing

Before processing a direct iMessage buffer, the conversation agent may send a
fire-and-forget request to Sendblue:

```text
POST /api/send-typing-indicator
number={phoneNumber}
from_number={SENDBLUE_FROM_NUMBER}
```

This only runs when all of the following are true:

- `OUTBOUND_TYPING_INDICATORS_ENABLED` is true.
- The conversation is direct.
- The conversation channel is `imessage`.
- The conversation is not currently marked `smsDowngraded`.

Typing send failures are logged at debug level and do not block the chat
endpoint or message delivery. SMS/downgraded conversations suppress outbound
typing indicators because iMessage-only affordances should not be shown after
SMS fallback.

### Inbound typing

Sendblue `typing_indicator` webhooks are accepted at
`POST /webhook/typing-indicator` and parsed from:

- `number`
- `from_number`
- `is_typing`
- `timestamp`

The handler stores the latest typing state on the direct conversation record
when `INBOUND_TYPING_STATE_ENABLED` is true. Typing webhooks do not call the chat
endpoint and do not create replies on their own. The next buffered direct
message request includes:

```json
{
  "typing": {
    "isTyping": true,
    "timestamp": "2026-05-06T12:00:00.000Z",
    "receivedAt": "2026-05-06T12:00:01.000Z"
  }
}
```

If no typing state is available, `typing` is `null`.

## Code files

| File | Role |
| --- | --- |
| `src/http/app.ts` | Typing webhook route |
| `src/sendblue/parser.ts` | Typing webhook parser |
| `src/sendblue/client.ts` | Sendblue typing indicator API call |
| `src/conversation/agent.ts` | Outbound typing gate and inbound typing state updates |
| `src/conversation/chat-request.ts` | Adds typing state to chat requests |
| `src/conversation/types.ts` | `ConversationTypingState` type |

## Configuration

- `OUTBOUND_TYPING_INDICATORS_ENABLED`
- `INBOUND_TYPING_STATE_ENABLED`
- `SENDBLUE_API_KEY_ID`
- `SENDBLUE_API_SECRET_KEY`
- `SENDBLUE_FROM_NUMBER`
- `REDIS_URL`

## Known limitations

- Inbound typing state is a latest-value field, not a timeline.
- Inbound typing can create an idle conversation record so the next message has
  context, but it does not call the chat endpoint without a receive webhook.
- Outbound typing is best effort and currently has no retry/backoff policy.
- The implementation assumes typing indicators are useful only for active
  iMessage direct conversations.
