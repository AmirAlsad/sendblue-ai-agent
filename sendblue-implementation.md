# Sendblue Implementation

## Context

This document covers the implementation of the Sendblue-specific messaging layer — everything between Sendblue's API and the developer's chat endpoint. The conversation intelligence layer (buffering, state machine, ordered delivery) is being ported from the `twilio-ai-agent` project's shared abstractions and is not covered here except where Sendblue-native alternatives should be evaluated.

The test harness described in `testing-infrastructure.md` should be functional before this implementation begins. Every feature built here should be validated against real iMessages as it's developed, not tested after the fact.

## Version Progression

### v0.1 — Basic Text Loop

This is the minimum viable agent. The goal is a working send-receive cycle with no intelligence layer — just plumbing.

**Inbound (Sendblue → Agent → Chat Endpoint):**

- Stand up an Express (or equivalent) server with a `POST /webhook/receive` endpoint that accepts Sendblue's inbound webhook payload.
- Parse the payload. The key fields for v0.1: `content`, `from_number`, `to_number`, `message_handle`, `is_outbound`, `status`, `was_downgraded`, `service`, `media_url`, `group_id`, `participants`, `send_style`, `message_type`. Not all of these are used in v0.1, but they should all be parsed and available — later versions need them without a schema change.
- Forward the message content and sender identifier to the developer's configured chat endpoint URL.
- Handle chat endpoint failures gracefully: timeouts, 5xx, malformed responses. The user should not get a broken conversation state because the AI had a bad moment.

**Outbound (Chat Endpoint Response → Agent → Sendblue → iMessage):**

- Take the chat endpoint's response and send it via Sendblue's `POST https://api.sendblue.co/api/send-message` API.
- Include `status_callback` pointing back to the agent's own `POST /webhook/status` endpoint on every outbound message.
- Parse status callbacks as they arrive. Track each message through the lifecycle: `REGISTERED → PENDING → QUEUED → ACCEPTED → SENT → DELIVERED`. Log terminal states (`DELIVERED`, `ERROR`). On `ERROR`, log the `error_code`, `error_message`, and `error_detail` fields.
- Deduplicate on `message_handle` — Sendblue retries up to 3 times on 5xx with a 45-second timeout.

**Webhook security:**

- The webhook signing secret header name is not published in Sendblue's docs. The first implementation task is to capture a real webhook locally (via ngrok) and inspect the headers to identify the correct key. Once confirmed, validate it on every inbound request and reject unsigned/incorrectly-signed requests.

**Configuration:**

- The developer provides: Sendblue API key and secret (`sb-api-key-id`, `sb-api-secret-key`), chat endpoint URL, webhook signing secret, and the port to run on. Environment variables are the simplest interface.

**Webhook registration:**

- Provide a setup script or initialization function that registers webhook URLs with Sendblue's API (`POST /api/account/webhooks`). This should be optional — the developer can also configure webhooks manually in the Sendblue dashboard. The programmatic approach is preferred because it ensures the webhook URLs stay in sync with the running server, but the dashboard fallback is important for developers who prefer manual control or hit issues with the API.

**What "done" looks like for v0.1:**

A developer clones the repo, sets env vars (Sendblue creds, chat endpoint URL), starts the server, exposes it via ngrok, configures Sendblue webhooks, and can text the Sendblue number from their phone. The message hits their chat endpoint, the response comes back as an iMessage, and the status callback confirms delivery. This is validated by the E2E test suite.

---

### v0.2 — Conversation Intelligence

This version ports the shared abstractions from `twilio-ai-agent`: message buffering, ordered delivery, conversation state machine, and typing indicators.

**What to port:**

The specific components and their implementations come from the `twilio-ai-agent` codebase. The developer should examine that project's source and identify which modules are provider-agnostic (and can be used directly or with minimal adaptation) vs. which are Twilio-specific.

**What to evaluate against Sendblue-native features:**

Some of these conversation intelligence components have potential Sendblue-native equivalents. For each, the developer should determine whether the ported application-layer implementation or the Sendblue-native feature is the better fit:

- **Typing indicators:** Sendblue has a `send_typing_indicator` API endpoint. This may be simpler to use than an application-layer implementation, but check latency and reliability — if the API call adds meaningful delay before the AI starts "thinking," the ported version might be better.
- **Message buffering:** Sendblue does not appear to offer native message batching. This almost certainly needs to be the ported application-layer implementation.
- **Ordered delivery:** Sendblue doesn't guarantee delivery order for multiple concurrent `send-message` calls. This needs application-layer sequencing.

**State persistence:**

The `twilio-ai-agent` project's approach to state persistence (in-memory vs. pluggable storage like Redis) needs to be examined. This is an open question — determine what twilio-ai-agent does, evaluate whether the same approach works for sendblue-ai-agent, and flag if it doesn't.

**Chat endpoint contract:**

The shared contract between the agent and the developer's chat endpoint is defined in the `twilio-ai-agent` project. Port it as-is unless there's a Sendblue-specific reason to deviate (e.g., if the contract doesn't account for iMessage-specific metadata that the chat endpoint might need).

**What "done" looks like for v0.2:**

Same setup as v0.1, but now the agent buffers rapid multi-message bursts into a single AI call, delivers multi-part AI responses in order, shows typing indicators while the AI is processing, and manages conversation state correctly across message exchanges. The E2E test for "send 3 messages quickly → verify single AI call with all 3 messages" passes.

---

### v0.3 — Rich Messaging

This version adds the iMessage-specific features that make the agent feel native to the platform.

**Media handling (inbound):**

- When a `receive` webhook includes a `media_url`, download or pass through the media URL to the chat endpoint. Define how media is represented in the chat endpoint contract — at minimum, include the URL and any available metadata (type, size if Sendblue provides it).
- Handle multiple media items in a single message if Sendblue supports it.

**Media handling (outbound):**

- When the chat endpoint response includes media, send it via Sendblue's `media_url` parameter in the `send-message` call.
- Verify media delivery via the status callback — confirm it reaches `DELIVERED` and check for any media-specific error codes.

**Send effects:**

- Support iMessage send effects (`send_style` parameter) on outbound messages. The documented values include effects like celebration, fireworks, shooting star, slam, and others. The chat endpoint response contract should provide a way for the AI to specify an effect.
- Parse incoming `send_style` from inbound webhooks and pass it to the chat endpoint so the AI is aware of the user's expressive intent.

**Reactions / Tapbacks:**

- Handle inbound tapback messages (likes, hearts, etc.) — these arrive as a distinct `message_type` or payload shape. Parse and forward to the chat endpoint.
- Support outbound tapbacks if Sendblue's API allows it.

**SMS fallback handling:**

- When `was_downgraded` is `true` in the inbound webhook, the message was delivered as SMS rather than iMessage. The agent should:
  - Inform the chat endpoint that this conversation is operating in SMS mode (so the AI can avoid referencing iMessage-specific features).
  - Suppress or adapt features that don't work over SMS: no send effects, no tapbacks, no high-quality media.
  - Track the downgraded state per-conversation so subsequent messages in the same conversation are handled consistently, at least until an iMessage delivery succeeds again.

**What "done" looks like for v0.3:**

The agent handles images, video, and files in both directions. The AI can send celebration effects. Tapbacks from the user are forwarded to the chat endpoint. When a message is downgraded to SMS, the agent adapts gracefully. All validated by E2E tests with real media and real SMS fallback scenarios.

---

### v0.4 — Groups + Operational

**Group conversations:**

- Route inbound group messages by `group_id`. The chat endpoint needs to receive group context: the group ID, participant list, and group display name.
- Manage group state — track participants, handle join/leave events if Sendblue surfaces them.
- Support group management API calls if available (creating groups, adding/removing participants, updating group name).

**Programmatic webhook registration:**

- On agent startup, optionally register or update webhook URLs via Sendblue's API (`POST/PUT /api/account/webhooks`). The agent should detect if webhooks are already configured and skip registration if the URLs match.
- Support all webhook types: `receive`, `outbound`, `typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, `contact_created`.
- If the API registration fails, log a clear message directing the developer to configure webhooks manually in the Sendblue dashboard.

**Error handling for messaging constraints:**

- Handle the 24-hour messaging window constraint. When an outbound message fails because of this window, surface a clear error to the developer (not a generic "send failed") with guidance on what triggered it.
- Handle all documented Sendblue error codes with specific error types or messages:
  - `4001` — rate limited. Implement backoff and retry.
  - `5509` — rate window exceeded. Surface to developer.
  - `SMS_LIMIT_REACHED` — surface to developer.
  - `4002` — blacklisted number (e.g., 911). Do not retry.
  - `5000`, `5003` — server errors. Retry with backoff.
  - `10001`, `10002` — send/status-resolve failures. Log and surface.

**What "done" looks like for v0.4:**

The agent supports group iMessage conversations with proper routing. Webhooks are auto-registered on startup. Error codes produce specific, actionable error messages instead of generic failures. The developer has full observability into what went wrong when a message fails.
