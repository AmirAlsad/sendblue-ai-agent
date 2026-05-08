# showcase-bot

The reference architecture for a real LLM-backed bot on this transport. It
returns the actual `actions[]` chat contract — every reply, reaction,
media send, and silence is a tool the LLM chooses to call.

Use this when you want to see what a production-grade bot looks like with
nothing redacted.

## What it shows

- **Multi-provider via Vercel AI SDK** — swap `model:` in `config.yaml`
  between `anthropic:claude-sonnet-4-6`, `anthropic:claude-haiku-4-5`,
  `openai:gpt-4o-mini`, etc.
- **Tools that build the chat contract** — `send_message`, `send_media`,
  `react`, `reply_to`, `stay_silent`. The LLM picks which to call; each
  appends a `ChatAction` instead of side-effecting.
- **Per-conversation history** keyed by the transport's `conversation.key`,
  so iMessage/SMS/RCS switches stay on one record.
- **Multimodal inbound media** — images go to the model multimodal,
  PDFs are extracted via `pdf-parse`, vCards are parsed, audio is
  transcribed via Groq Whisper if `GROQ_API_KEY` is set.
- **Group routing** — defers to the transport: only responds when
  `conversation.invocation.reason === 'name'`.
- **Identity passthrough** — if `identity` is included in the chat
  request, the user's name shows up in the per-turn context.
- **Anthropic prompt caching** — the system prompt is cached via
  `cacheControl: { type: 'ephemeral' }` for lower latency on repeats.

## Setup

The bot reads its API keys from `examples/showcase-bot/.env` (relative to
the repo root):

```bash
cd examples/showcase-bot
npm install                                    # installs Vercel AI SDK + deps
cp .env.example .env                           # creates examples/showcase-bot/.env
# edit that file and fill in ANTHROPIC_API_KEY
# optional: OPENAI_API_KEY, GROQ_API_KEY
```

## Run

The fastest way is from the repo root via the chat REPL — it boots the
bot, waits for `/health`, and drops you into an interactive prompt:

```bash
npm run example:chat -- showcase-bot
```

REPL commands inside that prompt: `/sms on|off` simulates an SMS-downgraded
conversation, `/reset` starts a fresh `conversationKey`, `/raw` toggles
the full JSON response, `/help` lists everything, `/exit` quits.

To exercise it over **real iMessage** to your Sendblue line — the runner
boots the bot, the agent, ngrok, and webhooks all wired up:

```bash
# from the repo root, with SENDBLUE_*, NGROK_AUTHTOKEN, E2E_TEST_DEVICE_NUMBER in .env
npm run example:dev -- showcase-bot
```

To run the bot standalone (so you can point a different agent or your
own `CHAT_ENDPOINT_URL` at it):

```bash
npm run dev          # tsx watch — restarts on file changes
# or
npm start            # one-shot, no watch
# then
CHAT_ENDPOINT_URL=http://localhost:4006/chat
```

## Configuration

| Field          | Default                          | Notes                                                   |
| -------------- | -------------------------------- | ------------------------------------------------------- |
| `port`         | `4006`                           |                                                         |
| `model`        | `anthropic:claude-sonnet-4-6`    | Any Vercel AI SDK provider                              |
| `maxTokens`    | `1024`                           | Per-response cap                                        |
| `maxSteps`     | `6`                              | Tool-calling step cap per turn                          |
| `systemPrompt` | _(see config.yaml)_              | Tells the model how to use the action-building tools    |

## Tools (LLM-callable)

| Tool          | Effect                                                            |
| ------------- | ----------------------------------------------------------------- |
| `send_message`| Append `{ type: 'message' }` action; optional `sendStyle`         |
| `send_media`  | Append `{ type: 'media' }` action with hosted URL                 |
| `react`       | Append `{ type: 'reaction' }` action targeting a `messageHandle`  |
| `reply_to`    | Append `{ type: 'reply' }` action targeting a `messageHandle`     |
| `stay_silent` | Set the response to `{ silence: true }` and clear other actions   |

If the LLM produces final text *and* hasn't already queued an outbound
action, that text is wrapped as a `message` action. This makes the bot
work even when the model forgets to use `send_message`.

## Curl recipe

```bash
curl -s http://localhost:4006/chat \
  -H 'content-type: application/json' \
  -d '{
    "message": "hello, can you tell me a quick joke?",
    "messageHandle": "msg-abc123",
    "channel": "imessage",
    "fromNumber": "+15551112222",
    "toNumber": "+15553334444",
    "conversation": {
      "key": "direct:+15553334444:+15551112222",
      "type": "direct",
      "channel": "imessage",
      "smsDowngraded": false
    },
    "sendblue": { "wasDowngraded": false, "raw": {} }
  }' | jq
```

## When to use this vs the other examples

- `minimal-chat-endpoint` — fastest possible echo target.
- `identity-lookup` — shape demo for `USER_LOOKUP_URL`.
- `action-catalog` — every action type in a labeled handler, no LLM.
- `scripted-flow` — a real conversation arc, no LLM, deterministic.
- `showcase-bot` — what you actually fork when building a real bot.
