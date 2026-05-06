# Conversation State and Chat Contract

## What it does

Defines the direct-conversation record, channel state, SMS downgrade behavior,
chat endpoint request shape, and response contract used by v0.2 conversation
intelligence.

## How it works

Each direct conversation has one mutable record keyed as:

```text
direct:{sendblueLine}:{phoneNumber}
```

The record is not split by SMS versus iMessage. Instead, it tracks current
channel metadata:

- `channel` - `imessage`, `sms`, `rcs`, or `unknown`.
- `smsDowngraded` - true after an SMS service or downgrade signal.
- `typing` - latest inbound typing state, when enabled and when the Sendblue
  account/line can actually receive the documented `typing_indicator` webhook.
- `identity` - optional resolved user identity.

Channel state is updated from receive and status webhook metadata. `service:
"SMS"` or `was_downgraded: true` marks the conversation as SMS/downgraded.
`service: "iMessage"` clears `smsDowngraded`, allowing iMessage-only behavior
such as outbound typing indicators again. RCS is tracked as its own conversation
channel and is forwarded to the chat endpoint as `rcs` on both the top-level
`channel` field and `conversation.channel`.

Per-feature channel gating at outbound time (per
https://docs.sendblue.com/api-v2/):

- **iMessage-only**: outbound typing indicators, typing refreshes, send effects
  (`sendStyle`), and Tapback reactions. Sent only when the direct conversation
  is currently iMessage and not downgraded.
- **iMessage and RCS**: read receipts (`POST /api/mark-read`). Sent for both
  iMessage and RCS direct conversations; suppressed for SMS and downgraded
  conversations.
- Send effects are silently dropped on SMS/downgraded/RCS conversations; the
  text or media still sends.
- Reactions are skipped (with `skipReason`) on SMS/downgraded/RCS conversations.
- Read receipts are also account-gated by Sendblue — even when the channel
  qualifies, the `mark-read` call requires Sendblue support to enable the
  feature on the account.

The chat request remains backward compatible:

```json
{
  "message": "first\n---\nsecond",
  "fromNumber": "+15551110001",
  "toNumber": "+15552220000",
  "messageHandle": "recv-001",
  "channel": "imessage"
}
```

v0.2 adds structured context:

```json
{
  "messages": [
    {
      "content": "first",
      "fromNumber": "+15551110001",
      "toNumber": "+15552220000",
      "messageHandle": "recv-001",
      "channel": "imessage",
      "mediaUrl": null,
      "messageType": "message",
      "sendStyle": "",
      "raw": {}
    }
  ],
  "conversation": {
    "key": "direct:+15552220000:+15551110001",
    "type": "direct",
    "lineNumber": "+15552220000",
    "phoneNumber": "+15551110001",
    "channel": "imessage",
    "smsDowngraded": false,
    "state": "processing"
  },
  "identity": null,
  "typing": null,
  "sendblue": {
    "wasDowngraded": false,
    "service": "iMessage",
    "mediaUrl": null,
    "groupId": null,
    "groupDisplayName": null,
    "sendStyle": "",
    "messageType": "message",
    "raw": {}
  }
}
```

The chat endpoint can reply in any of these backward-compatible forms:

```json
{ "message": "single reply" }
```

```json
{ "messages": ["first reply", "second reply"] }
```

```json
{ "silence": true }
```

Empty strings are ignored inside `messages`. `{ "silence": true }` produces no
Sendblue call.

Rich capability builds add a preferred `actions[]` response contract for
transport features that cannot be represented as plain strings:

```json
{
  "actions": [
    { "type": "message", "content": "First ordered reply." },
    {
      "type": "message",
      "content": "Photo caption.",
      "mediaUrl": "https://cdn.example.com/photo.png",
      "sendStyle": "celebration"
    },
    { "type": "reaction", "reaction": "love", "target": { "alias": "latest" } },
    {
      "type": "reply",
      "content": "Replying directly.",
      "target": { "messageHandle": "recv-123" }
    }
  ]
}
```

The rich contract is documented in
[`docs/features/rich-chat-actions.md`](rich-chat-actions.md). Legacy `message`
and `messages` responses should normalize to ordered message actions, while
`silence` should remain an explicit no-op.

## Code files

| File | Role |
| --- | --- |
| `src/conversation/types.ts` | Conversation record, key, channel helpers |
| `src/conversation/chat-request.ts` | Aggregated and structured chat request creation |
| `src/conversation/agent.ts` | Channel transitions, state transitions, response handling |
| `src/chat/types.ts` | Public chat request/response types |
| `src/chat/client.ts` | HTTP chat client and response normalization |
| `docs/features/rich-chat-actions.md` | Rich `actions[]` and XML compatibility contract |

## Configuration

- `CHAT_ENDPOINT_URL`
- `CHAT_ENDPOINT_TIMEOUT_MS`
- `REDIS_URL`
- `CONVERSATION_TTL_SECONDS`
- `MAX_REPROCESS_ATTEMPTS`
- `OUTBOUND_TYPING_INDICATORS_ENABLED`
- `INBOUND_TYPING_STATE_ENABLED`
- `CHAT_RESPONSE_PARSE_TAGS`
- `READ_RECEIPTS_ENABLED`
- `READ_RECEIPT_DEBOUNCE_MS`
- `TYPING_REFRESH_INTERVAL_MS`
- `TYPING_REFRESH_MAX_MS`
- `AGENT_DISPLAY_NAME`
- `VALID_USER_REQUIRED`

## Known limitations

- Group conversation records are present for addressed inbound groups. Unaddressed
  groups are still deduped, logged, metadata-preserved, and silent.
- `cancelledMessages` are tracked in state for interruptions but are not yet
  included in the public chat request.
- The top-level `channel`, `conversation.channel`, and `messages[].channel`
  can expose `imessage`, `sms`, `rcs`, or `unknown`.
