# sendblue-ai-agent — Project Overview

## What This Is

`sendblue-ai-agent` is an open-source package that gives developers the infrastructure to deploy an AI agent over iMessage using the Sendblue API. A developer brings their own chat endpoint — any URL that accepts a message payload and returns a response — and this package handles everything else: receiving iMessages via Sendblue webhooks, managing conversation state, delivering AI responses back as iMessages, and supporting the full range of iMessage-specific features (media, reactions, send effects, group messaging).

The target user is a developer who already has an AI chat endpoint (whether that's a full conversational engine or a simple API call to an LLM) and wants to make it accessible over iMessage without building the messaging infrastructure themselves.

## What This Is Not

This is not a chatbot framework, an LLM wrapper, or an AI toolkit. It has no opinions about what the AI does or how it generates responses. It is pure messaging infrastructure: webhook ingestion, message routing, delivery management, and the iMessage-specific features that Sendblue exposes. The AI layer is the developer's responsibility.

## Why This Exists

Sendblue provides a clean API for sending and receiving iMessages, but there's a meaningful gap between "I have API credentials" and "I have a working AI agent in iMessage." That gap includes webhook handling, message buffering (so multi-message bursts from a user arrive as a single payload to the AI), ordered delivery of multi-part responses, status tracking through Sendblue's full delivery lifecycle, typing indicators, SMS fallback detection, media handling, and group conversation routing. This package fills that gap.

## Architecture

The package sits between Sendblue and the developer's chat endpoint:

```
User's iPhone (iMessage)
        │
        ▼
   Sendblue (cloud)
        │
        ▼
┌─────────────────────────┐
│   sendblue-ai-agent     │
│                         │
│  Webhook ingestion      │
│  Message buffering      │
│  Conversation state     │
│  Delivery management    │
│  Media handling         │
│  Group routing          │
│  SMS fallback detection │
└─────────┬───────────────┘
          │
          ▼
  Developer's Chat Endpoint
  (any URL that accepts a
   message and returns a
   response)
```

## Chat Endpoint Contract

The interface between `sendblue-ai-agent` and the developer's AI is defined by the shared abstractions ported from the `twilio-ai-agent` project. The exact shape of this contract — request payload, response format, support for streaming or multi-bubble responses, media in responses — will be determined during the porting phase. The goal is a contract simple enough that a developer can wire up a basic endpoint in minutes, but flexible enough to support more sophisticated interaction patterns.

## Sendblue Assumptions

- **Dedicated line required.** The package assumes the developer has a Sendblue account with a dedicated phone number. Shared numbers won't work because webhook routing depends on account-level webhook configuration.
- **No sandbox-to-sandbox flow.** Sendblue does not offer a way to simulate inbound messages or fire test webhooks. Testing the full pipeline requires a real iMessage-capable device on the other end. This is why the test harness is a core component of this project, not an afterthought.

## Version Roadmap

The Sendblue implementation is split into progressive versions, each adding a layer of capability:

### v0.1 — Basic Text Loop
The minimum viable agent. Inbound webhook handling for Sendblue's `receive` event, outbound text messaging via Sendblue's `send-message` API, status callback tracking through the full delivery lifecycle (`REGISTERED → PENDING → QUEUED → ACCEPTED → SENT → DELIVERED`), and chat endpoint integration. At the end of v0.1, a developer can receive an iMessage, hit their AI endpoint, and send a text response back. No buffering, no ordering guarantees — the agent works, just naively.

### v0.2 — Conversation Intelligence
Ported from the `twilio-ai-agent` project's shared abstractions. Message buffering with a growth-factor timer (so rapid multi-message bursts from a user are batched into a single AI call), an ordered delivery queue for multi-part AI responses, a conversation state machine, and typing indicators (both inbound and outbound). Some of these components may map directly onto Sendblue-native features (e.g., Sendblue has a `send_typing_indicator` API endpoint) — the developer should evaluate whether to use the ported application-layer implementation or the Sendblue-native equivalent for each component.

### v0.3 — Rich Messaging
Inbound and outbound media support (images, video, files via Sendblue's `media_url` field), iMessage send effects (`send_style` — celebration, fireworks, slam, etc.), reactions/tapbacks, and SMS fallback handling. When `was_downgraded` is `true` in the webhook payload, the agent must detect this and adjust behavior appropriately — iMessage-specific features (effects, tapbacks, high-quality media) won't work, and the chat endpoint should be informed so the AI can adapt its responses.

### v0.4 — Groups + Operational
Group conversation support (routing by `group_id`, participant awareness, group management), programmatic webhook registration via Sendblue's API (`POST/PUT/DELETE /api/account/webhooks`) with manual dashboard configuration as a fallback, and proper error handling for the 24-hour messaging window constraint and other Sendblue-specific error codes (`4001` rate-limited, `5509` rate-window-exceeded, `SMS_LIMIT_REACHED`, etc.).

## Testing Philosophy

The test harness is arguably the most important component in this repo. Because Sendblue has no webhook simulator or sandbox-to-sandbox messaging, the only way to validate the full pipeline is with real iMessages. The repo includes:

- **Unit tests** that replay captured Sendblue webhook fixtures against the handler code, with mocked outbound calls. These run on any machine, no hardware required, and cover the bulk of regression testing.
- **End-to-end tests** that send real iMessages through the full loop using a BlueBubbles server running on a Mac. These validate the entire pipeline from "user sends iMessage" to "AI response arrives as iMessage on user's device."

Both tiers are documented in `testing-infrastructure.md`.

## Key Technical Details from Sendblue's API

A few details that will matter during implementation:

- **Webhook types:** `receive`, `outbound`, `typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, `contact_created`. Configured via Sendblue's webhook CRUD API or the dashboard.
- **Webhook security:** Per-webhook `secret`, account-level `globalSecret`, or legacy root `secret`. The secret is included in request headers, but the exact header name is not published in Sendblue's docs. This needs to be confirmed by capturing a real webhook locally or contacting Sendblue support.
- **Status lifecycle:** The canonical statuses are `REGISTERED`, `PENDING`, `DECLINED`, `QUEUED`, `ACCEPTED`, `SENT`, `DELIVERED`, and `ERROR`. Note: `READ` is not part of the formal contract despite appearing in some Sendblue marketing copy. Do not depend on it.
- **`status_callback`** must be passed on each `send-message` request — there is no global default.
- **Error codes:** `4000` (validation), `4001` (rate-limited), `4002` (blacklisted), `5000` (internal), `5003` (server-rate), `5509` (rate-window-exceeded), `10001` (send failure), `10002` (status-resolve failure), `SMS_LIMIT_REACHED`.
- **Retry policy:** Sendblue retries webhooks up to 3 times on 5xx responses with a 45-second timeout. Deduplicate on `message_handle`.
