# twilio-ai-agent

A runnable Node.js service that wires Twilio (SMS / WhatsApp / RCS) to your AI chat endpoint. It handles all the hairy transport pieces — buffering rapid-fire messages, ordered outbound delivery, status callbacks, typing indicators, reply context, read receipts, out-of-band triggers — so your chat code only has to answer "given this message, what should I say back?"

The chat endpoint is a single HTTP URL you configure. **Your AI can be in any language.** Python, Go, Rust, Bun, Deno — anything that speaks JSON over HTTP.

## What it does

| Feature | Why it matters |
|---|---|
| **Message buffering** with exponential-backoff timer | Users send "hey" then "actually" then "wait one more thing" — call your chat endpoint once with the aggregated text instead of three rapid-fire calls. |
| **Ordered outbound delivery** with status-callback choreography | Two-message replies arrive in order, never mixed up with the next round. |
| **WhatsApp typing indicators** (Twilio v2 Indicators API) | "Typing…" shows up while your chat endpoint is thinking. |
| **Reply context capture** | When a WhatsApp user swipe-replies to a previous message, the package forwards the original message SID + timestamp so your chat endpoint can resolve and annotate. |
| **RCS / WhatsApp / iMessage read receipts** | Twilio reports `read`; the package forwards `{userId, messageTimestamp, readAt}` to a configurable URL. |
| **Out-of-band triggers** | `POST /triggers` with `{userId, message, metadata}` to push a message to a user from a scheduler / webhook / cron / anywhere. Per-user locked, ordered, dead-lettered on failure. |
| **Broadcast fan-out** | `userId: 'ALL'` triggers walk your user adapter and fan out at a configurable rate. |
| **Optional eligibility gate** | Pluggable predicate (paid users only, beta cohort, whatever) with a Redis-backed rate-limited "you can't message right now" redirect. |

## Architecture

```
┌──────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Twilio  │ ──► │ twilio-ai-agent  │ ──► │  Your chat       │
│ webhook  │     │ (this package)   │     │  endpoint        │
└──────────┘     │                  │     │  (any language)  │
                 │  + Redis         │     └──────────────────┘
                 │  + BullMQ        │
                 └──────────────────┘
                          ▲
                          │ POST /triggers
                          │
              ┌───────────┴───────────┐
              │ Your scheduler /      │
              │ cron / webhook source │
              └───────────────────────┘
```

## Quickstart

```bash
git clone <this-repo> twilio-ai-agent
cd twilio-ai-agent
npm install
cp .env.example .env
# Edit .env (see "Required configuration" below)

# Start the bundled echo mocks if you don't have a real chat endpoint yet:
node examples/mock-services/user-lookup.js &     # :4000
node examples/mock-services/chat-endpoint.js &   # :4001

# Start Redis (or point REDIS_URL at a hosted instance)
redis-server &

# Tunnel + run
ngrok http 3001 &
npm run dev
```

In the Twilio console, set your phone number's webhook to `https://<ngrok>.ngrok.io/sms/webhook` (or `.../whatsapp/webhook`) and the status callback to `https://<ngrok>.ngrok.io/status/callback`.

Send an SMS — the chat endpoint receives the buffered payload, returns a reply, and the user gets your response.

See `HOWTO.md` for the full walkthrough.

## Required configuration

Minimum `.env` to send your first reply:

```bash
NODE_ENV=development
PORT=3001

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+15551234567
TWILIO_MESSAGING_SERVICE_SID=MG...
STATUS_CALLBACK_URL=https://<your-public-url>/status/callback

REDIS_URL=redis://localhost:6379

CHAT_ENDPOINT_URL=https://your-app.example.com/chat
USER_LOOKUP_URL=https://your-app.example.com/user-lookup

TRIGGER_API_KEY=replace-with-strong-random-string
```

Full inventory + tunables: `.env.example` and `docs/features/configuration.md`.

## How your chat endpoint should look

The package POSTs to `CHAT_ENDPOINT_URL` with a documented JSON shape and accepts either blocking JSON or streaming NDJSON in response. Full spec + a runnable Node example: `examples/chat-endpoint-pseudocode.md`.

Two runnable examples ship with the package:

- `examples/mock-services/chat-endpoint.js` — 30-line echo. Use for the README quickstart smoke test.
- `examples/test-chat-endpoint/` — programmable: script queue, rule matchers, NDJSON streaming, failure injection (5xx / socket throw), configurable delays, and a `/_admin/calls` inspector. Run as a standalone server (`node examples/test-chat-endpoint/server.js`) and drive over HTTP, or import in-process. Designed for integration tests but useful any time you need a deterministic stand-in for your AI.

## How user lookup works

Two modes:

1. **HTTP webhook (default)** — Set `USER_LOOKUP_URL`. The package POSTs `{resolveBy: "phone"|"userId"|"listActive", value, ...}` and expects a user record back (or `null` for not-found).
2. **In-process JS adapter** — Drop a JS file at `./adapters/user.js` exporting `resolveByPhone`, `resolveByUserId`, optionally `listActiveUsers` and `isEligible`. Takes precedence over the HTTP webhook. See `examples/adapters/user.js.example`.

## Sending out-of-band triggers

```bash
curl -X POST http://localhost:3001/triggers \
  -H "X-Trigger-API-Key: $TRIGGER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-1",
    "message": "Reminder: your appointment is in 15 minutes",
    "timestamp": "2026-05-03T12:00:00Z",
    "metadata": {"source": "scheduler", "reminderId": "abc"}
  }'
```

Use `userId: 'ALL'` to fan out to every user via the adapter's `listActiveUsers`.

## Feature deep-dives

- [Message buffering](docs/features/message-buffering.md)
- [Ordered delivery](docs/features/ordered-delivery.md)
- [WhatsApp typing + reply context](docs/features/whatsapp-typing-and-reply-context.md)
- [Read receipts (RCS / WhatsApp / iMessage)](docs/features/rcs-read-receipts.md)
- [Triggers](docs/features/triggers.md)
- [Broadcasts](docs/features/broadcasts.md)
- [Eligibility gate (optional)](docs/features/eligibility-gate.md)
- [Inbound webhooks](docs/features/inbound-webhooks.md)
- [Configuration reference](docs/features/configuration.md)

## Tests

```bash
npm run test:unit              # zero-dep unit tests (gate predicate + redirect dispatch + rate-limit)
npm run test:integration       # end-to-end behavior tests (requires Redis on localhost:6379)
npm test                       # both
```

The integration suite boots the actual agent against a programmable mock chat endpoint, an in-process user-lookup stub, and a require.cache-mocked Twilio sender that simulates Twilio's status-callback choreography. It covers:

- Inbound webhook → buffer → chat → Twilio happy path
- Multi-message burst aggregation with the `\n---\n` delimiter
- Silence (`{silence: true}`) skips Twilio
- Multi-message responses arrive in order via the status-callback queue advance
- NDJSON streaming responses
- `success: false + fallbackMessage` is sent via Twilio
- 5xx from the chat endpoint → built-in fallback message
- Unknown user → silently dropped (or `UNKNOWN_USER_MESSAGE` if configured)
- Trigger flow (POST /triggers → resolve → chat → Twilio); silence on triggers; auth rejection
- WhatsApp reply context (`OriginalRepliedMessageSid`) forwarded to chat
- Twilio `read` status callbacks forwarded to `READ_RECEIPT_URL`
- `/health` endpoint shape

Test helpers live under `tests/integration/helpers/`: `chat-endpoint.js` (in-process wrapper around `examples/test-chat-endpoint/app.js`) and `agent-harness.js` (boots + drives the full agent). Reuse them when writing new tests.

CI runs the full suite on Node 18 / 20 / 22 with a Redis service container — see `.github/workflows/ci.yml`.

## License

MIT — see [LICENSE](LICENSE).

## Status

Early. The infrastructure (state machine, queues, status callbacks, gate plumbing, trigger system) is battle-tested in production. The OSS-friendly packaging — adapter contracts, env layout, docs — is new. Issues + PRs welcome.
