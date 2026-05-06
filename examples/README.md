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

Inbound typing state appears only when Sendblue delivers the documented
`typing_indicator` webhook. Some live accounts may reject or fail to persist
that webhook type during registration, so examples should treat `typing` as
optional metadata.

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
- `reply` returns a reply-intent action targeting the latest inbound message.
  Current Sendblue direct sends do not expose a native reply target parameter,
  so the agent preserves the intent and delivers a normal message fallback.
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
multi-message tags, media, send effects, reactions, reply-intent fallback, and
silence.

## Live Showcase Endpoint

`npm run showcase:e2e` starts its own scenario-aware chat endpoint instead of
using one of the standalone example servers. It is meant for a real Sendblue
line and `E2E_TEST_DEVICE_NUMBER`: the script sends guided prompts, the local
endpoint returns rich responses for each scenario, and the agent replies with an
echo of what it understood.

The live prompts are conversational and do not require copying hidden scenario
tokens. The runner maps each inbound webhook to the active step and writes the
actual chat request evidence to `summary.json`.

Set `SHOWCASE_MEDIA_URL` to a public HTTPS asset if the outbound media step
should send hosted media. Without it, the script still runs and the media step
explains that hosted media was skipped. Captures and `summary.json` are written
under `.captures/sendblue-showcase/<session>/`.

The live showcase uses `SHOWCASE_*` timing settings for the buffering and
typing demos so normal `.env` runtime values do not make the interaction too
tight. The defaults intentionally use a longer buffer quiet window and a longer
read/typing processing pause than the production examples.

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
