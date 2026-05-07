# AGENTS.md

This file provides guidance for Codex and other coding agents working on `sendblue-ai-agent`.

## Project Intent

`sendblue-ai-agent` is a greenfield open-source Node.js package that gives developers the messaging infrastructure to deploy an AI agent over iMessage using the Sendblue API.

The package is not a chatbot framework, LLM wrapper, prompt manager, or AI toolkit. It should only handle transport and orchestration:

- Sendblue webhook ingestion
- Sendblue outbound message delivery
- Status callback tracking
- Message buffering and ordered delivery
- Conversation state
- Typing indicators
- Media, reactions, send effects, SMS fallback, and group routing as versions progress

The developer brings their own chat endpoint. Keep the chat endpoint HTTP/language agnostic and avoid coupling this package to any specific model provider.

## Source Of Truth

The durable project guidance now lives in this file, `README.md`, and `docs/`.
Historical setup files and the old external reference tree have been removed
after their useful decisions were captured in the Sendblue implementation,
feature docs, examples, and tests.

## Version Roadmap

Build progressively:

- `v0.1`: Basic text loop. Express server, `POST /webhook/receive`, Sendblue `send-message`, required per-message `status_callback`, status lifecycle tracking, chat endpoint integration, webhook deduplication, basic config.
- `v0.2`: Conversation intelligence. Implemented with direct conversation state, rapid-message buffering, Redis/BullMQ production infrastructure, in-memory test/local fallback, ordered outbound delivery, optional identity enrichment, and typing-indicator state.
- `v0.3`: Rich messaging. Implemented with hosted media sends, iMessage send effects, Tapback reactions, contextual reply intent, direct read receipts, typing refreshes, XML tag compatibility, SMS fallback handling via `was_downgraded`, and addressed inbound group routing.
- `v0.4`: Groups and operations. Future work includes richer group operations, participant management, webhook registration, Sendblue-specific error handling, retries/backoff, and clearer operational diagnostics.

Prefer small vertical slices that can be tested with real Sendblue/iMessage behavior.

## Sendblue Constraints

Important API assumptions:

- The package assumes a dedicated Sendblue line. Shared numbers are not supported.
- Sendblue has no inbound webhook simulator or sandbox-to-sandbox iMessage flow. Real-device E2E testing is load-bearing.
- The Sendblue API is not always foolproof or uniformly enabled across accounts. When documented behavior fails in live testing, preserve local diagnostics and distinguish implementation bugs from account/API gating or vendor-side issues that need Sendblue support.
- Webhook types documented by Sendblue include `receive`, `outbound`, `typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, and `contact_created`. Treat `typing_indicator` as account/API-gated until live registration is verified; observed live webhook APIs may reject or drop it even though the docs list it.
- Sendblue retries webhooks up to 3 times on 5xx responses with a 45-second timeout. Deduplicate on `message_handle`.
- Status callbacks use `REGISTERED`, `PENDING`, `DECLINED`, `QUEUED`, `ACCEPTED`, `SENT`, `DELIVERED`, and `ERROR`. Sendblue does NOT emit a `READ` status callback; do not depend on one. Read receipts are a best-effort `POST /api/mark-read` call gated by `READ_RECEIPTS_ENABLED`.
- `status_callback` must be passed on each `send-message` request; there is no global default.
- Ordered delivery is channel-aware: iMessage/RCS queues advance on `DELIVERED`; SMS and downgraded conversations advance on `SENT`.
- The webhook secret header is `sb-signing-secret` per Sendblue's security docs (https://docs.sendblue.com/security): "Sendblue sends `sb-signing-secret` header with requests. Verify this matches your configured secret." It is a literal shared-secret string, not an HMAC signature over the body. Keep `SENDBLUE_WEBHOOK_SECRET_HEADER` configurable as a compatibility alias for legacy installs and confirm from a captured real webhook before enforcing in production. See `docs/features/webhook-security.md`.
- Important error codes include `4000`, `4001`, `4002`, `5000`, `5003`, `5509`, `10001`, `10002`, and `SMS_LIMIT_REACHED`.
- Sendblue outbound typing indicators are direct iMessage-only. Do not send typing indicators or typing refreshes for SMS, downgraded conversations, or unaddressed groups. Inbound typing state depends on successfully registering the documented `typing_indicator` webhook for the account/line.
- Per-feature channel support matrix (per https://docs.sendblue.com/api-v2/):
  - Send effects (`send_style`), Tapback reactions, replies, outbound typing indicators, typing refreshes — **iMessage-only.** Suppress or safely degrade for SMS, downgraded, and RCS conversations.
  - Read receipts (`POST /api/mark-read`) — **iMessage and RCS** per https://docs.sendblue.com/api-v2/read-receipts/. Suppress for SMS and downgraded conversations.
  - Group routing — silent unless addressed to `AGENT_DISPLAY_NAME`, a best-effort Tapback/reply references a known agent outbound, or future payloads include explicit reply metadata targeting the agent. Acknowledge, dedupe, preserve/log metadata, and only reply by `group_id` for addressed inbound-initiated groups.
- `was_downgraded` is conversation-significant state but is *not* sticky for life: when a previously-downgraded conversation receives a fresh `service: "iMessage"` payload, `smsDowngraded` clears so iMessage-only features re-engage. The alternative — sticky-for-life downgrade — would suppress iMessage features forever for users who briefly fall off iMessage and return.
- Sendblue's Contacts v2 API (`GET /api/v2/contacts/:phone_number`) is operator-managed contact metadata, not application user identity. Do not use it as a fallback for the identity resolver — application user identity remains a developer concern via `USER_LOOKUP_URL` or an injected `identityResolver`.

## Testing Strategy

Use Vitest for this greenfield package.

Unit tests should run without hardware and cover:

- Sendblue webhook parsing
- Status lifecycle handling
- Deduplication by `message_handle`
- Conversation buffering, late arrivals, interruption behavior, and ordered delivery advancement
- Chat endpoint request/response contract
- Sendblue outbound API mocking
- Sendblue typing indicator API mocking and inbound typing state
- Rich chat `actions[]` normalization, XML tag compatibility, action ordering, and silence handling
- Hosted media, send effects, reactions, replies, read receipts, typing refresh cancellation, and SMS downgrade suppression
- Addressed group routing decisions that do not require live Sendblue credentials
- Optional identity resolver success, null, and failure-open behavior
- Chat endpoint failures
- SMS downgrade behavior
- Configurable webhook secret validation

E2E tests should be separate from CI by default and require:

- A macOS host signed into Messages.app with iMessage enabled
- Full Disk Access for the terminal or test runner reading `~/Library/Messages/chat.db`
- Sendblue credentials and dedicated line
- A public tunnel such as ngrok
- Real Sendblue dashboard/API webhook configuration

Expected commands once implemented:

```bash
npm test
npm run test:e2e
```

## Implementation Guidance

- Default to Node.js with Express unless the project is explicitly re-scaffolded differently.
- Keep provider-specific code isolated under Sendblue-oriented modules so future transport changes are possible.
- Use environment variables for Sendblue credentials, chat endpoint URL, webhook secret, public callback URLs, port, rich action tag compatibility, read receipts, typing refreshes, identity authorization, and group addressing.
- Treat Redis/BullMQ as the production path for v0.2 state, timers, dedupe, and queues. Keep the in-memory path available for tests and local smoke runs only.
- Direct conversation keys are `direct:{sendblueLine}:{phoneNumber}`. Do not split iMessage and SMS into separate conversation records; store SMS/downgrade as conversation-significant state.
- Parse and preserve future-facing Sendblue fields early, even if v0.1 does not use them: `content`, `from_number`, `to_number`, `message_handle`, `is_outbound`, `status`, `was_downgraded`, `service`, `media_url`, `group_id`, `participants`, `send_style`, and `message_type`.
- Treat `was_downgraded` as conversation-significant state because iMessage-only features may need suppression after SMS fallback.
- Preserve the chat endpoint's top-level `message` string for backward compatibility. Add richer context through structured `messages[]`, `conversation`, `identity`, and `typing` objects rather than replacing the old contract.
- Preserve the chat endpoint's legacy `message`, `messages`, and `silence` response forms. Prefer the rich `actions[]` response contract for new media, effect, reaction, contextual reply, silence, and group-addressed behavior. Read receipts and typing refresh are agent-side behaviors around processing and ordered delivery.
- XML tag compatibility is only a bridge for model outputs that cannot reliably emit JSON. Normalize supported tags into `actions[]`; do not expose XML tags as transport-specific source code abstractions.
- Optional identity resolution is enrichment, not admission control. The agent catches any error from `resolveByPhone`, logs at warn level, and proceeds with `identity: null`. Resolvers should throw on transport, timeout, non-2xx, and parse errors so the agent log captures them.
- Any HTTP call that runs inline before chat dispatch (identity lookup, future authorization hooks) must enforce a timeout via `AbortSignal.timeout`. Hung lookups will stall buffering and outbound delivery.
- Sendblue's TypeScript SDK docs reference `SENDBLUE_API_API_KEY` / `SENDBLUE_API_API_SECRET`. This package uses `SENDBLUE_API_KEY_ID` / `SENDBLUE_API_SECRET_KEY` to mirror the documented HTTP header names (`sb-api-key-id` / `sb-api-secret-key`). Keep the existing names; document the discrepancy in user-facing config docs.
- Prefer structured logs with enough fields to debug webhook delivery, Sendblue API responses, and chat endpoint failures.
- Avoid adding LLM-specific assumptions to the package contract.

## Documentation and Examples

- Keep durable, current implementation docs under `docs/`.
- Use the existing `docs/features/` format for feature docs: what it does, how it works, code files, configuration, and known limitations.
- Every load-bearing module (anything in `src/sendblue/`, `src/chat/`, `src/conversation/`, `src/http/`, `src/status/`, `src/identity/`, `src/config/`) should have a feature doc. New PRs that add a module should add or update the corresponding feature doc.
- Examples should be runnable without Sendblue hardware unless explicitly labeled as E2E. Prefer small Express examples that show the chat endpoint, optional identity lookup, v0.2 request metadata, rich `actions[]`, XML tag compatibility, silence, reactions, replies, hosted media, send effects, and addressed group behavior.
- The transport package itself (`src/`) stays model-provider-free: no OpenAI/Anthropic/etc. SDKs in the root `package.json`, and no LLM-specific assumptions in the chat contract. Example subdirectories under `examples/` with their own isolated `package.json` may bring any provider; `examples/showcase-bot/` is the canonical example using Vercel AI SDK + Anthropic/OpenAI/Groq.
