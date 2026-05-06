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
- `typing` - latest inbound typing state, when enabled.
- `identity` - optional resolved user identity.

Channel state is updated from receive and status webhook metadata. `service:
"SMS"` or `was_downgraded: true` marks the conversation as SMS/downgraded.
`service: "iMessage"` clears `smsDowngraded`, allowing iMessage-only behavior
such as outbound typing indicators again. RCS is tracked as its own conversation
channel, but the legacy top-level chat `channel` field maps RCS to `unknown` for
backward compatibility.

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

## Code files

| File | Role |
| --- | --- |
| `src/conversation/types.ts` | Conversation record, key, channel helpers |
| `src/conversation/chat-request.ts` | Aggregated and structured chat request creation |
| `src/conversation/agent.ts` | Channel transitions, state transitions, response handling |
| `src/chat/types.ts` | Public chat request/response types |
| `src/chat/client.ts` | HTTP chat client and response normalization |

## Configuration

- `CHAT_ENDPOINT_URL`
- `CHAT_ENDPOINT_TIMEOUT_MS`
- `REDIS_URL`
- `CONVERSATION_TTL_SECONDS`
- `MAX_REPROCESS_ATTEMPTS`
- `OUTBOUND_TYPING_INDICATORS_ENABLED`
- `INBOUND_TYPING_STATE_ENABLED`

## Known limitations

- Group conversation records and group chat contracts are intentionally absent
  in v0.2.
- `cancelledMessages` are tracked in state for interruptions but are not yet
  included in the public chat request.
- The top-level `channel` field only exposes `imessage`, `sms`, or `unknown`;
  use `conversation.channel` or `messages[].channel` for `rcs`.
