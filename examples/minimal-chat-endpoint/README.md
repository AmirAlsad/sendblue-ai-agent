# minimal-chat-endpoint

The smallest possible `CHAT_ENDPOINT_URL` target — a 30-line Express server
that echoes whatever message comes in. Use it as the very first thing you
wire up while bringing the agent online.

## Run

The easiest way is via the repo-root REPL:

```bash
npm run example:chat -- minimal-chat-endpoint
```

Or boot it directly and point your agent at it:

```bash
node examples/minimal-chat-endpoint/server.js
# then
CHAT_ENDPOINT_URL=http://localhost:4001/chat
```

## Behavior

| Input            | Response                  |
| ---------------- | ------------------------- |
| `silence`        | `{ silence: true }`       |
| _anything else_  | `{ message: "Echo: ..." }` |

## When to graduate

- For richer responses (reactions, media, send effects), go to
  [`../action-catalog/`](../action-catalog/).
- For a real conversation arc, see [`../scripted-flow/`](../scripted-flow/).
- For a real LLM bot, see [`../showcase-bot/`](../showcase-bot/).
