# Trigger Ingestion and Processing

## What it does

Accepts trigger payloads from external services (your scheduler, cron, webhook source, etc.), queues them per user, and processes them when the user's conversation state is idle. The package treats triggers as opaque transport — it doesn't format the message or interpret the metadata, just relays the trigger payload to the chat endpoint.

## How it works

`POST /triggers` validates payloads (auth via `X-Trigger-API-Key`) and enqueues them in Redis. The trigger worker polls for users with pending triggers, acquires a per-user lock, resolves the user's channel via the adapter, runs the optional eligibility gate, fires a WhatsApp typing indicator if applicable, and POSTs to `CHAT_ENDPOINT_URL` with the trigger payload. The chat endpoint's response is queued for ordered delivery via Twilio.

Failed triggers are retried with exponential backoff and eventually moved to a dead letter list (`triggers:failed` in Redis). Triggers blocked by the gate dead-letter immediately with `error: 'gated_ineligible'` (no retry, no chat endpoint call, no Twilio send).

## Request shape

```http
POST /triggers
X-Trigger-API-Key: <TRIGGER_API_KEY>
Content-Type: application/json
```

```json
{
  "userId": "string-or-ALL",
  "message": "string",
  "timestamp": "2026-05-03T12:00:00Z",
  "metadata": { "anything": "opaque, forwarded as-is" }
}
```

`type` is optional. If you send one, it's preserved in the trigger record and forwarded to the chat endpoint inside `trigger.type`.

`userId: 'ALL'` initiates a broadcast — see `broadcasts.md`.

## What the chat endpoint receives

```json
{
  "userId": "...",
  "phoneNumber": "+E.164",
  "message": "the trigger.message verbatim",
  "interface": "sms" | "whatsapp",
  "trigger": {
    "id": "uuid",
    "type": "your-optional-type",
    "metadata": { ... }
  },
  "user": { ... }
}
```

The chat endpoint is responsible for whatever framing makes sense for your use case (system prompt insertion, prefix tagging, persona-flavored intros). The package does **not** wrap the trigger in XML, prepend `<response_guidance>`, or add any opinionated framing — that concern lives in your chat endpoint, not this transport layer.

## Code files

| File | Role |
| --- | --- |
| `src/routes/trigger-ingestion.js` | HTTP API for triggers (validation, broadcast routing) |
| `src/triggers/trigger-queue.js` | Redis trigger queues + dead-letter |
| `src/triggers/trigger-worker.js` | Polling worker + readiness checks + per-user locks |
| `src/triggers/trigger-processor.js` | Channel resolution, gate, typing, chat-endpoint call |
| `src/triggers/channel-resolver.js` | Resolves a userId → {channel, phone, opaque user data} via the adapter |
| `src/utils/gate.js` | Optional eligibility gate (predicate shared with the inbound chokepoint) |

## Configuration

- `TRIGGER_API_KEY` — required to authenticate `POST /triggers`
- `TRIGGER_QUEUE_TTL_DAYS`
- `TRIGGER_MAX_RETRIES`
- `TRIGGER_RETRY_DELAY_MS`
- `TRIGGER_POLL_INTERVAL_MS`
- `TRIGGER_LOCK_TTL_SECONDS`
- `TRIGGER_MAX_CONCURRENT_USERS`
- `CHAT_ENDPOINT_URL`
- `REDIS_URL`

## Known limitations

- The trigger worker uses polling; large volumes may need tuning for concurrency and poll interval.
- Trigger queues are per user, so very large fan-outs should use the broadcast system.
