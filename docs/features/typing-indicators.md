# Typing Indicators

## What it does

Supports outbound Sendblue typing indicators and local ingestion for Sendblue's
documented inbound typing webhook. Outbound typing is an API call the agent can
make during processing. Inbound typing state is included in the next
direct-message chat request only when the account/line can actually register and
receive `typing_indicator` webhooks.

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

Typing refreshes are agent-controlled, not requested by rich `actions[]`.
During processing, the agent sends an initial typing indicator and then refreshes
on `TYPING_REFRESH_INTERVAL_MS` until the response completes, the conversation
downgrades to SMS, a terminal send status arrives, or a newer inbound message
interrupts the current response.

### Inbound typing

Sendblue documents `typing_indicator` as the inbound typing webhook type. The
local agent accepts it at
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

### Live registration status

Do not assume inbound typing callbacks are available just because the parser and
route exist locally. In live testing on May 6, 2026, Sendblue's webhook API
rejected `POST /api/account/webhooks` with `type: "typing_indicator"` and an
allowed-type list that omitted `typing_indicator`. A full webhook `PUT` returned
success but did not persist the `typing_indicator` entry on the follow-up
`GET /api/account/webhooks`.

The current interpretation is:

- Outbound `/api/send-typing-indicator` exists and can be exercised as a
  best-effort direct iMessage API call.
- Inbound `typing_indicator` is documented and locally supported, but may be
  account/API-gated or unavailable for some Sendblue accounts.
- E2E and production setup must verify registration persistence before claiming
  inbound typing support for a deployment.

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
- `TYPING_REFRESH_INTERVAL_MS`
- `TYPING_REFRESH_MAX_MS`
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
- Some live Sendblue account webhook APIs may reject or fail to persist
  `typing_indicator` webhook registration even though the public docs list it as
  supported. Local ingestion remains implemented, but real inbound typing
  capture depends on account/API behavior.
- The implementation assumes typing indicators are useful only for active
  iMessage direct conversations.
- Typing refresh API success is not a guarantee that Messages.app visibly
  displays continuous typing.
