# Architecture

## Overview

`twilio-ai-agent` receives SMS/WhatsApp/RCS webhooks from Twilio, buffers inbound messages, calls a configurable HTTP chat endpoint, and delivers responses in order with delivery confirmation. Outbound goes through a Twilio Messaging Service (so an RCS sender in the pool enables RCS-first / SMS fallback). RCS / WhatsApp read receipts are forwarded to an optional `READ_RECEIPT_URL`. For WhatsApp, typing indicators are fired before the chat call, and inbound swipe-reply context is captured and forwarded to the chat endpoint. A trigger ingestion API lets external services push messages to users out-of-band.

An optional **eligibility gate** can be enabled via the user adapter — block users who don't meet a custom predicate, with a Redis-backed rate-limited redirect message. The gate is OFF by default. See `docs/features/eligibility-gate.md`.

## Components

- `src/index.js` — Express server, middleware, routes, startup/shutdown
- `src/routes/` — Twilio webhook handlers, status-callback handler, trigger ingestion endpoint
- `src/state/` — Redis-backed conversation state machine; stores opaque `userData` JSON forwarded to the chat endpoint
- `src/timers/` — BullMQ buffer timers for message aggregation
- `src/queue/` — Ordered outbound delivery and status-callback choreography. `read-receipt-store.js` holds the 72h Redis SID→{userId, timestamp} mapping used by both read receipts and WhatsApp reply lookups.
- `src/triggers/` — Trigger ingestion, queue, per-user-locked worker, broadcast fan-out
- `src/adapters/` — User-lookup adapter (HTTP webhook or JS file), chat-endpoint client
- `src/utils/` — Twilio sender, Redis client, pino logger, optional gate, WhatsApp typing helper
- `tests/unit/` — Zero-dep unit tests; child-process-per-file runner

## Data flow

```mermaid
flowchart LR
  Twilio[Twilio Webhooks] -->|SMS/WhatsApp| Agent[twilio-ai-agent]
  Agent --> Adapter[(User Adapter)]
  Adapter -->|not found| Unknown[UNKNOWN_USER_MESSAGE<br/>optional]
  Adapter -->|found| Gate{Eligibility Gate<br/>(optional)}
  Gate -->|blocked| Redirect[Twilio Redirect<br/>rate-limited]
  Gate -->|passed| State[Redis State]
  State --> Timers[BullMQ Buffer Timers]
  Timers --> Chat[Chat Endpoint<br/>$CHAT_ENDPOINT_URL]
  Chat --> Queue[Outbound Queue]
  Queue --> TwilioOut[Twilio Send]
  TwilioOut -->|Status Callback| Agent
  TwilioOut -->|read event| ReadCb[$READ_RECEIPT_URL<br/>optional]
  TriggersAPI[POST /triggers] --> TriggerQueue[Redis Trigger Queue]
  TriggerQueue --> TriggerWorker[Trigger Worker]
  TriggerWorker --> Adapter
  TriggerWorker --> OutGate{Eligibility Gate<br/>(optional)}
  OutGate -->|blocked| DeadLetter[Dead Letter<br/>gated_ineligible]
  OutGate -->|passed| Chat
```

## External dependencies

- **Twilio** — inbound webhooks + outbound messaging (RCS-first with SMS fallback via Messaging Service)
- **Redis** — conversation state, queue state, trigger queues, BullMQ
- **Your chat endpoint** (HTTP) — response generation; any language
- **Your user-lookup endpoint** (HTTP) OR `./adapters/user.js` — phone↔userId resolution

## Key design decisions

- Redis-backed state and queue data to survive restarts and scale horizontally
- BullMQ timers for buffering to avoid race conditions across instances
- Ordered delivery with status callbacks to ensure message sequencing
- Trigger worker uses polling instead of timers because readiness depends on user state
- Adapter loader prefers in-process JS file over HTTP webhook (faster, no extra hop)
- All user-data fields flow opaquely from the adapter through the state machine to the chat endpoint — the package itself doesn't interpret personality, context, prompt, or any other AI-layer concern

## Feature inventory

- [Inbound webhooks](features/inbound-webhooks.md)
- [Eligibility gate (optional)](features/eligibility-gate.md)
- [Message buffering and interruptions](features/message-buffering.md)
- [Ordered delivery with status callbacks](features/ordered-delivery.md)
- [RCS / WhatsApp / iMessage read receipts](features/rcs-read-receipts.md)
- [WhatsApp typing indicators and reply context](features/whatsapp-typing-and-reply-context.md)
- [Trigger ingestion and processing](features/triggers.md)
- [Broadcast distribution](features/broadcasts.md)
- [Configuration and tunables](features/configuration.md)
