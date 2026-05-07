# action-catalog

A single chat endpoint with one labeled handler per action type. Use it to see
exactly what response shape the transport expects for each capability — without
needing a Sendblue line. The handlers mirror the scenarios that
`npm run showcase:e2e` exercises end-to-end.

## Run

```bash
node examples/action-catalog/server.js
# then
CHAT_ENDPOINT_URL=http://localhost:4003/chat
```

For the XML tag-parser path:

```bash
CHAT_ENDPOINT_URL=http://localhost:4003/chat?mode=xml
```

## Handlers

Each keyword triggers a single handler returning a single response shape.
Copy a block straight out of `server.js` into your real bot.

| Keyword     | What it returns                                                                  |
| ----------- | -------------------------------------------------------------------------------- |
| `silence`   | `{ silence: true }` (the canonical form)                                         |
| `multi`     | Two ordered `message` actions (queue advances on per-channel status)             |
| `react`     | `reaction` action targeting the last inbound `messageHandle` (iMessage-only)     |
| `reply`     | `reply` action with a `target` ref + content                                     |
| `media`     | `media` action with `mediaUrl` (uses `HOSTED_MEDIA_URL` or a public placeholder) |
| `effect`    | `message` action with `sendStyle: 'celebration'` (iMessage-only)                 |
| `group`     | Replies in groups only when addressed; otherwise silence                         |
| `downgrade` | Returns text that explains which features the transport has suppressed          |
| _anything_  | Help text listing the available keywords                                         |

SMS/downgraded conversations get plain-text fallbacks for `react` and `effect`
so you can see how iMessage-only features degrade.

## Curl recipe

```bash
curl -s http://localhost:4003/chat \
  -H 'content-type: application/json' \
  -d '{"message":"react","messageHandle":"abc-123","channel":"imessage","sendblue":{"wasDowngraded":false,"raw":{}}}' \
  | jq
```

## Configuration

| Env var               | Default                     | Notes                                            |
| --------------------- | --------------------------- | ------------------------------------------------ |
| `PORT`                | `4003`                      |                                                  |
| `AGENT_DISPLAY_NAME`  | `sb-agent`                  | Used to detect addressed group messages          |
| `HOSTED_MEDIA_URL`    | a public PNG                | Set to your own HTTPS asset for the `media` demo |
