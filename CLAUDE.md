# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working on twilio-ai-agent.

## Project overview

`twilio-ai-agent` is a runnable Node.js service that sits between Twilio (SMS/WhatsApp/RCS webhooks) and a user-supplied AI chat endpoint. It does generic plumbing — buffering rapid-fire messages, ordered outbound delivery, status-callback choreography, WhatsApp typing indicators, reply context capture, RCS/WhatsApp read-receipt forwarding, and an optional out-of-band trigger system for scheduled or system-event messages.

The chat endpoint is HTTP and language-agnostic; the user-lookup adapter is either an HTTP webhook (env-var driven) or a JS file at `./adapters/user.js`. The package itself does not assemble prompts, talk to LLMs, or store user data — it strictly handles transport and orchestration.

## Architecture

```
Twilio webhooks ──▶ Express server ──▶ Redis state + BullMQ buffer timers
       │                                       │
       │                                       ▼
       │                            WhatsApp typing indicator (channel-conditional)
       │                                       │
       │                                       ▼
       │                            User-adapter resolveByPhone
       │                                       │
       │                                       ▼
       │                            Optional eligibility gate
       │                                       │
       │                                       ▼
       │                            POST $CHAT_ENDPOINT_URL (NDJSON streaming)
       │                                       │
       │                                       ▼
       │                            Outbound queue ──▶ Twilio send (RCS-first / SMS fallback)
       │                                       │
       │                       Status callback ◀┘
       │                       (delivered/failed/read)
       │
       │                       Read events ──▶ POST $READ_RECEIPT_URL (optional)

POST /triggers ──▶ Redis trigger queue ──▶ Per-user lock ──▶ Channel resolver
                                                                    │
                                                                    ▼
                                                          Same chat-endpoint flow
```

Per-feature deep-dives live under `docs/features/`. `docs/ARCHITECTURE.md` is the inventory entry point.

## Test/CI infrastructure note

`src/index.js` auto-starts the agent unless `AGENT_NO_AUTOSTART=1` is set. The integration harness sets this and then calls `start({port: 0})` directly to control the lifecycle. Don't add any auto-start side effects outside that gate — they'll break the integration suite.

The integration suite requires Redis. Local dev: `redis-server` on `localhost:6379`. Tests use db 15 by convention. Override with `TEST_REDIS_URL` (e.g. `TEST_REDIS_URL=redis://localhost:6379/14` to share with another test session).

Integration tests run with `--test-concurrency=1`. Tests within `agent-flows.test.js` share a single agent harness (one mock chat endpoint, one Twilio mock, one Redis db); running them in parallel produces races on the script queue and the conversation state machine. If you split the suite across files later, each file gets its own subprocess (the default `--test-isolation=process` flag handles isolation between files), so concurrency is fine across files but not within them.

## Commands

```bash
npm install
npm start                       # Production mode
npm run dev                     # NODE_ENV=development; debug routes enabled
npm run test:unit               # Zero-dep unit tests (child-process-per-file)
npm run test:unit -- --grep gate    # Filter by path
npm run test:integration        # node:test integration suite (uses test-chat-endpoint helper)
npm test                        # Both unit and integration

# Standalone test chat endpoint (programmable; for manual smoke tests or
# non-Node integration runners). See examples/test-chat-endpoint/README.md
# for the admin HTTP API.
node examples/test-chat-endpoint/server.js
```

No build step.

## Layout

- `src/index.js` — Express server, middleware, workers, graceful shutdown
- `src/routes/` — Twilio webhooks (`sms-webhook.js`, `whatsapp-webhook.js`), shared `webhook-handler.js`, status callbacks, trigger ingestion
- `src/state/` — Redis-backed conversation state machine. Stores an opaque `userData` JSON string (whatever the user-adapter returns under `data`) so the buffer worker can forward it to the chat endpoint when the timer fires.
- `src/timers/` — BullMQ buffer timers for rapid-fire message aggregation
- `src/queue/` — Ordered delivery + status-callback handling. `read-receipt-store.js` holds the 72h Redis SID→{userId, timestamp} mapping used by both read receipts and WhatsApp reply lookups.
- `src/triggers/` — Trigger ingestion, queueing, processing, broadcast distribution. The trigger system is a thin transport — payload `{userId, message, metadata?}` is forwarded to the chat endpoint with `interface: <channel>` and an opaque `trigger` field; consumers do their own formatting.
- `src/adapters/` — Pluggable adapters. `chat-endpoint-client.js` (HTTP transport for chat calls), `user-adapter.js` (loader: prefers `./adapters/user.js`, falls back to HTTP webhook), `http-user-adapter.js` (HTTP webhook implementation).
- `src/utils/` — Twilio sender, Redis client, pino logger, `gate.js` (optional eligibility gate with rate-limited redirect), `twilio-typing.js` (v2 Indicators API).
- `examples/mock-services/` — bare 30-line echo chat endpoint and user-lookup webhook for the README quickstart smoke test.
- `examples/test-chat-endpoint/` — programmable chat endpoint (script queue, rule matchers, NDJSON streaming, failure injection, delays, call inspection) usable as a runnable server with HTTP control plane OR as an in-process module. Same Express app powers both. See its `README.md` for the admin API.
- `tests/unit/` — zero-dep unit tests (child-process-per-file runner, pure mocks via `require.cache`). See `tests/unit/README.md`.
- `tests/integration/` — `node:test` integration suite covering inbound buffering + aggregation, silence/fallback/multi-message/streaming responses, ordered delivery, unknown-user handling, trigger flow, reply context, and read receipts. Boots the actual agent against a programmable mock chat endpoint, an in-process user-lookup stub, and a require.cache-mocked Twilio sender that simulates status callbacks. Helpers under `tests/integration/helpers/`: `chat-endpoint.js` (in-process wrapper around `examples/test-chat-endpoint/app.js`) and `agent-harness.js` (boots + drives the full agent).
- `.github/workflows/ci.yml` — runs unit + integration tests on Node 18/20/22 with a Redis service container on every PR + push to main.

## Data flow

1. **Inbound**: Twilio webhook → validate signature (production only) → `userAdapter.resolveByPhone` → optional gate → capture WhatsApp reply context → buffer in Redis → BullMQ timer fires → fire WhatsApp typing indicator → POST `$CHAT_ENDPOINT_URL` with `stream: true` → queue response messages for ordered delivery.
2. **Outbound**: Pop from queue → send via Twilio Messaging Service → store SID mapping for read receipts → wait for status callback → send next.
3. **Read receipts**: Twilio `read` status callback → look up SID → POST `$READ_RECEIPT_URL` (if configured) → clean up mapping.
4. **Triggers**: POST `/triggers` → enqueue → worker polls → resolve user via `resolveByUserId` → optional gate → fire WhatsApp typing → POST chat endpoint with `interface: <channel>` and `trigger` payload → queue response.
5. **Broadcast** (`userId: 'ALL'`): walks `userAdapter.listActiveUsers({limit, cursor})` paginated → fans out one trigger per user at `BROADCAST_RATE_LIMIT` jobs/sec.

## Adapter contract

When `./adapters/user.js` exists, the loader uses it. The file must export:

```js
module.exports = {
  async resolveByPhone(phone) {
    // returns { userId, phone, channel, data? } | null
  },
  async resolveByUserId(userId) {
    // returns { userId, phone, channel, data? } | null
  },
  async listActiveUsers({ limit, cursor }) {
    // returns { users: [userId, ...], nextCursor: string | null }
    // Optional — only needed for broadcast triggers
  },
  async isEligible({ userId, data }) {
    // returns true | false | { allowed: bool, redirect?: string }
    // Optional — enables the gate
  }
};
```

If the JS file isn't present, the package falls back to the `USER_LOOKUP_URL` HTTP webhook adapter. Same contract over HTTP — see `examples/chat-endpoint-pseudocode.md` for shapes.

## Health

- `GET /health` — Redis + worker statuses + adapter mode (`jsfile` | `http` | `none`)
- `GET /triggers/health` — Trigger system health (queue depth, processing stats)

## Key configuration (`.env`)

- `NODE_ENV=production` — Enforces Twilio signature validation, raises log level
- `STATUS_CALLBACK_URL` — Required for ordered delivery (must be publicly reachable)
- `REDIS_URL` — Required for state, queues, and BullMQ
- `CHAT_ENDPOINT_URL` — Where to POST messages for AI response
- `USER_LOOKUP_URL` — User-adapter HTTP webhook (or use `./adapters/user.js`)
- `TWILIO_MESSAGING_SERVICE_SID` — Recommended for outbound (enables RCS-first / SMS fallback)
- `TRIGGER_API_KEY` — Authenticates trigger ingestion requests
- `READ_RECEIPT_URL` — Optional; if unset, read events are logged + dropped
- Buffer tuning: `BUFFER_BASE_TIMEOUT_MS`, `BUFFER_GROWTH_FACTOR`, `BUFFER_MAX_TIMEOUT_MS`
- Gate tuning: `GATE_REDIRECT_TTL_SECONDS`, `GATE_REDIRECT_MESSAGE`

Full env inventory: `docs/features/configuration.md`.

## Coding style

- JavaScript (CommonJS), 2-space indentation, semicolons
- Kebab-case filenames in `src/routes/`, `src/queue/`, `src/triggers/`, `src/adapters/`
- Logging via pino with structured key-value fields (no string interpolation)
- No linter configured; match existing style
