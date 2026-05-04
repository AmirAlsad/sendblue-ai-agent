# Configuration and Tunables

## What it does

Documents configuration groups and captures potential tuning knobs that are currently hard-coded.

## How it works

Environment variables are grouped by subsystem in `.env.example`. Runtime behavior is configured via `process.env` in the modules listed below.

## Code files

| File | Role |
|---|---|
| `.env.example` | Canonical env layout |
| `src/utils/logger.js` | Environment-aware logging |
| `src/index.js` | Runtime + webhook settings |
| `src/state/conversation-state.js` | Buffering + reprocess config |
| `src/triggers/trigger-worker.js` | Trigger worker tuning |
| `src/utils/gate.js` | Optional eligibility gate redirect TTL + body |
| `src/adapters/user-adapter.js` | User adapter loader (JS file vs HTTP) |
| `src/adapters/chat-endpoint-client.js` | Chat endpoint URL + read-receipt URL |

## Configuration

See `.env.example` for the complete set of supported variables. Categories:

- **Server**: `NODE_ENV`, `PORT`
- **Twilio**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`, `STATUS_CALLBACK_URL`
- **Backend**: `REDIS_URL`, `CHAT_ENDPOINT_URL`, `READ_RECEIPT_URL` (optional)
- **User resolution**: `USER_LOOKUP_URL`, `UNKNOWN_USER_MESSAGE`, `USER_LOOKUP_TIMEOUT_MS`
- **Trigger ingestion**: `TRIGGER_API_KEY`, plus tunables (`TRIGGER_QUEUE_TTL_DAYS`, `TRIGGER_MAX_RETRIES`, `TRIGGER_RETRY_DELAY_MS`, `TRIGGER_POLL_INTERVAL_MS`, `TRIGGER_LOCK_TTL_SECONDS`, `TRIGGER_MAX_CONCURRENT_USERS`)
- **Eligibility gate (optional)**: `GATE_REDIRECT_TTL_SECONDS`, `GATE_REDIRECT_MESSAGE`, `GATE_ELIGIBILITY_URL`
- **Buffering tunables**: `BUFFER_BASE_TIMEOUT_MS`, `BUFFER_GROWTH_FACTOR`, `BUFFER_MAX_TIMEOUT_MS`, `BUFFER_NOISE_MAX_DEVIATION`, `MAX_REPROCESS_ATTEMPTS`, `CANCELLED_MESSAGE_MAX_LENGTH`, `BUFFER_QUEUE_NAME`
- **Broadcast tunables**: `BROADCAST_QUEUE_NAME`, `BROADCAST_RATE_LIMIT`

## Potential tunables to promote to env vars

These are currently hard-coded in source files; PRs to surface them via `process.env` are welcome.

- `src/index.js`: webhook rate-limit window/max (suggest `WEBHOOK_RATE_LIMIT_WINDOW_MS`, `WEBHOOK_RATE_LIMIT_MAX`)
- `src/queue/queue-state.js`: `QUEUE_TTL_SECONDS` (suggest `DELIVERY_QUEUE_TTL_SECONDS`)
- `src/state/conversation-state.js`: `CONVERSATION_TTL_SECONDS` (suggest `CONVERSATION_TTL_SECONDS`)
- `src/queue/strategies/base-strategy.js`: delivery timeout and max retries
- `src/queue/message-queue-manager.js`: fallback error message and abort cleanup delay
- `src/adapters/chat-endpoint-client.js`: request timeout (suggest `CHAT_ENDPOINT_TIMEOUT_MS`)
- `src/timers/buffer-timer-worker.js`: worker concurrency, lock duration, stalled interval
- `src/timers/buffer-timer-manager.js`: BullMQ `removeOnFail` count
- `src/triggers/broadcast-manager.js`: per-page user fetch limit (currently 1000), max users per broadcast (10,000)
- `src/utils/redis-client.js`: reconnect attempts and timeouts
- `src/queue/read-receipt-store.js`: read-receipt mapping TTL (currently 72h)

## Organization notes

- Keep subsystem prefixes consistent (`BUFFER_`, `TRIGGER_`, `BROADCAST_`, `REDIS_`, `GATE_`, `TWILIO_`)
- Use units in variable names (`_MS`, `_SECONDS`) to avoid ambiguity
- Prefer one subsystem per section in `.env.example`, mirroring the docs/features layout

## Known limitations

- Some values are shared implicitly between modules; promoting them to env vars cleanly requires a config module to avoid duplication.
