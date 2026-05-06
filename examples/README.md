# sendblue-ai-agent examples

These examples are small Express services you can run next to the agent while
developing locally. They use only dependencies already installed by the root
package.

## Minimal Chat Endpoint

Use this when you want the fastest possible `CHAT_ENDPOINT_URL` target.

```bash
node examples/minimal-chat-endpoint/server.js
```

Then set:

```bash
CHAT_ENDPOINT_URL=http://localhost:4001/chat
```

The endpoint returns `{ message: "Echo: <message>" }`, which exercises the
backward-compatible single-message response shape.

## Identity Lookup Endpoint

Use this to test `USER_LOOKUP_URL` and the `identity` object included in v0.2
chat requests.

```bash
node examples/identity-lookup/server.js
```

Then set:

```bash
USER_LOOKUP_URL=http://localhost:4002/lookup
```

The sample resolver accepts the current resolver request shape:

```json
{
  "resolveBy": "phone",
  "value": "+15551234567",
  "phoneNumber": "+15551234567",
  "lineNumber": "+15557654321",
  "conversationKey": "direct:+15557654321:+15551234567"
}
```

It returns `{ "userId": "...", "data": { ... } }` for known numbers and `null`
for unknown numbers.

## v0.2 Rich Chat Endpoint

Use this when you want to see how a real application can consume buffered
messages, conversation metadata, resolved identity, inbound typing state, and
SMS downgrade state.

```bash
node examples/v02-rich-chat-endpoint/server.js
```

Then set:

```bash
CHAT_ENDPOINT_URL=http://localhost:4003/chat
```

Useful prompts to send from the device:

- `silence` returns `{ silence: true }`.
- `multi` returns multiple ordered replies.
- `human` returns a handoff-style reply.
- Any other input returns one reply that uses the v0.2 request context.

## Rich Actions Chat Endpoint

Use this with a rich-capable runtime when you want the chat endpoint to return
structured Sendblue actions instead of plain strings.

```bash
node examples/rich-actions-chat-endpoint/server.js
```

Then set:

```bash
CHAT_ENDPOINT_URL=http://localhost:4004/chat
```

Useful prompts to send from the device:

- `multi` returns two ordered `{ type: "message" }` actions.
- `silence` returns a rich `{ type: "silence" }` action.
- `reaction` returns a love reaction targeting the latest inbound message, or
  a plain fallback if the conversation is SMS/downgraded.
- `reply` returns a contextual reply action targeting the latest inbound
  message.
- `media` returns a hosted media message using `HOSTED_MEDIA_BASE_URL`.
- `effect` returns a message with `sendStyle: "celebration"`, or a plain
  fallback if the conversation is SMS/downgraded.
- `receipt` returns a normal message; read receipts are controlled by
  `READ_RECEIPTS_ENABLED` in the agent, not by chat actions.
- `typing` returns a normal message; typing refreshes are controlled by the
  agent while the chat request and outbound queue are active.
- `sb-agent group` returns a group reply only when the inbound request has group
  metadata and mentions `AGENT_DISPLAY_NAME`.

Set `CHAT_ENDPOINT_URL=http://localhost:4004/chat?mode=xml` to return XML-style
Sendblue tags in the legacy top-level `message` field. The XML mode demonstrates
multi-message tags, media, send effects, reactions, replies, and silence.

## Run Examples Locally

Use separate terminals:

```bash
node examples/minimal-chat-endpoint/server.js
node examples/identity-lookup/server.js
node examples/v02-rich-chat-endpoint/server.js
node examples/rich-actions-chat-endpoint/server.js
```

Only one chat endpoint should be assigned to `CHAT_ENDPOINT_URL` at a time. The
identity lookup service can run alongside either chat endpoint.
