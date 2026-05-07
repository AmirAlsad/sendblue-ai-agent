# sendblue-ai-agent examples

A guided tour of how to wire a chat endpoint and identity resolver to the
agent. Walk top to bottom — each example is meant to be read after the
ones above it.

| Example                                                  | When to use it                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| [`minimal-chat-endpoint/`](./minimal-chat-endpoint/)     | You're wiring `CHAT_ENDPOINT_URL` for the first time                 |
| [`identity-lookup/`](./identity-lookup/)                 | You need to enrich incoming chats with a `USER_LOOKUP_URL` lookup    |
| [`action-catalog/`](./action-catalog/)                   | You want to see every chat action type in a single labeled handler   |
| [`scripted-flow/`](./scripted-flow/)                     | You want a realistic conversation arc without an LLM                 |
| [`showcase-bot/`](./showcase-bot/)                       | You're forking a starting point for a real LLM-backed bot            |

Examples 1–4 are zero-dependency Express scripts using only what the root
`package.json` already installs. Example 5 (`showcase-bot/`) has its own
`package.json` and pulls in Vercel AI SDK + Anthropic/OpenAI/Groq.

## Try an example in 60 seconds

```bash
git clone <this repo>
cd sendblue-ai-agent
npm install
npm run example:chat -- action-catalog
```

That's the whole onboarding. `npm run example:chat -- <name>` boots the
example in a child process, waits for it to be healthy, and drops you into
a REPL that POSTs each line to `/chat` and pretty-prints the response. No
Sendblue account, no ngrok, no real iMessage device — pure local loop.

Available CLI targets: `minimal-chat-endpoint`, `action-catalog`,
`scripted-flow`, `showcase-bot`. (`identity-lookup` answers a different
route — see [`identity-lookup/`](./identity-lookup/) for how to run it
alongside one of the chat examples.)

```text
> hello
  message: Hi! How can I help?
> react to my last message with a heart
  reaction: love → m-1759-3
> /sms on
  smsDowngraded: true
> react with a heart
  message: Tapback reactions are iMessage-only; this conversation is SMS/downgraded.
> /reset
> /exit
```

REPL commands: `/sms on|off` simulates an SMS-downgraded conversation,
`/reset` generates a fresh `conversationKey` (clears bot memory),
`/raw` toggles the full JSON response, `/exit` quits.

For the **full hardware loop** — real iMessage device, real Sendblue line,
real webhooks via ngrok — use `npm run dev:e2e`. The full set of E2E
commands (`setup:e2e`, `verify:e2e`, `dev:e2e`, `sendblue:webhooks`,
`showcase:e2e`, `probe:sendblue`) is listed in the top-level `README.md`.

For `showcase-bot` you also need an Anthropic key:

```bash
cp examples/showcase-bot/.env.example examples/showcase-bot/.env
# add ANTHROPIC_API_KEY to that file
npm run example:chat -- showcase-bot
```

The CLI checks for the key before booting and tells you exactly what's
missing.

## 1 · `minimal-chat-endpoint` — hello world

A 30-line Express server that echoes the inbound message. Use it as the
fastest possible target while you bring up the agent locally.

```bash
node examples/minimal-chat-endpoint/server.js
# then
CHAT_ENDPOINT_URL=http://localhost:4001/chat
```

## 2 · `identity-lookup` — user enrichment

A stub for `USER_LOOKUP_URL` that returns a hardcoded identity for two
phone numbers. Run alongside any chat endpoint to see the `identity` block
appear in chat requests.

```bash
node examples/identity-lookup/server.js
# then
USER_LOOKUP_URL=http://localhost:4002/lookup
```

## 3 · `action-catalog` — every action type

One endpoint, one handler per action type (`message`, `media`, `reply`,
`reaction`, `silence`, `sendStyle`, group routing, SMS fallback). Mirrors
the scenarios that `npm run showcase:e2e` exercises. Append `?mode=xml` to
see the same content rendered as XML tags for the legacy parser path.

```bash
node examples/action-catalog/server.js
# then
CHAT_ENDPOINT_URL=http://localhost:4003/chat
```

## 4 · `scripted-flow` — a real conversation, no LLM

A pizza pickup state machine keyed by `conversation.key`. Walks through
greet → size → toppings → name → pickup, naturally hitting reactions,
replies, media, send effects, and silence as the conversation progresses.

```bash
node examples/scripted-flow/server.js
# then
CHAT_ENDPOINT_URL=http://localhost:4005/chat
```

## 5 · `showcase-bot` — fork-this-for-a-real-bot

LLM-backed via Vercel AI SDK. The model returns the `actions[]` chat
contract through five tools (`send_message`, `send_media`, `react`,
`reply_to`, `stay_silent`). Handles inbound media: images go multimodal,
PDFs are extracted, vCards are parsed, audio is transcribed via Groq.
Multi-provider — swap `model:` in `config.yaml` between Anthropic and
OpenAI.

```bash
cd examples/showcase-bot
npm install
cp .env.example .env  # fill in ANTHROPIC_API_KEY
npm run dev
# then
CHAT_ENDPOINT_URL=http://localhost:4006/chat
```

## Running examples in parallel

Use separate terminals. Only one chat endpoint should be assigned to
`CHAT_ENDPOINT_URL` at a time. The identity lookup runs alongside any of
the chat endpoints.
