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
- `v0.3`: Rich messaging. Inbound/outbound media, iMessage send effects, reactions/tapbacks, and SMS fallback handling via `was_downgraded`.
- `v0.4`: Groups and operations. Group routing by `group_id`, participant context, webhook registration, Sendblue-specific error handling, retries/backoff, and clearer operational diagnostics.

Prefer small vertical slices that can be tested with real Sendblue/iMessage behavior.

## Sendblue Constraints

Important API assumptions:

- The package assumes a dedicated Sendblue line. Shared numbers are not supported.
- Sendblue has no inbound webhook simulator or sandbox-to-sandbox iMessage flow. Real-device E2E testing is load-bearing.
- Webhook types include `receive`, `outbound`, `typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, and `contact_created`.
- Sendblue retries webhooks up to 3 times on 5xx responses with a 45-second timeout. Deduplicate on `message_handle`.
- Status callbacks use `REGISTERED`, `PENDING`, `DECLINED`, `QUEUED`, `ACCEPTED`, `SENT`, `DELIVERED`, and `ERROR`. Do not rely on `READ`.
- `status_callback` must be passed on each `send-message` request; there is no global default.
- Ordered delivery is channel-aware: iMessage/RCS queues advance on `DELIVERED`; SMS and downgraded conversations advance on `SENT`.
- The webhook secret header name is undocumented. Keep it configurable and confirm from a captured real webhook before enforcing in production.
- Important error codes include `4000`, `4001`, `4002`, `5000`, `5003`, `5509`, `10001`, `10002`, and `SMS_LIMIT_REACHED`.
- Sendblue typing indicators are direct iMessage-only. Do not send typing indicators for SMS, downgraded conversations, or groups.
- Group receives are intentionally silent in v0.2. Acknowledge, dedupe, preserve/log metadata, and wait for v0.4 group routing before replying.

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
- Use environment variables for Sendblue credentials, chat endpoint URL, webhook secret, public callback URLs, and port.
- Treat Redis/BullMQ as the production path for v0.2 state, timers, dedupe, and queues. Keep the in-memory path available for tests and local smoke runs only.
- Direct conversation keys are `direct:{sendblueLine}:{phoneNumber}`. Do not split iMessage and SMS into separate conversation records; store SMS/downgrade as conversation-significant state.
- Parse and preserve future-facing Sendblue fields early, even if v0.1 does not use them: `content`, `from_number`, `to_number`, `message_handle`, `is_outbound`, `status`, `was_downgraded`, `service`, `media_url`, `group_id`, `participants`, `send_style`, and `message_type`.
- Treat `was_downgraded` as conversation-significant state because iMessage-only features may need suppression after SMS fallback.
- Preserve the chat endpoint's top-level `message` string for backward compatibility. Add richer context through structured `messages[]`, `conversation`, `identity`, and `typing` objects rather than replacing the old contract.
- Optional identity resolution is enrichment, not admission control. Resolver errors should log and fail open with `identity: null`.
- Prefer structured logs with enough fields to debug webhook delivery, Sendblue API responses, and chat endpoint failures.
- Avoid adding LLM-specific assumptions to the package contract.

## Documentation and Examples

- Keep durable, current implementation docs under `docs/`.
- Use the existing `docs/features/` format for feature docs: what it does, how it works, code files, configuration, and known limitations.
- Examples should be runnable without Sendblue hardware unless explicitly labeled as E2E. Prefer small Express examples that show the chat endpoint, optional identity lookup, and v0.2 request metadata.
- Do not add model-provider-specific example code. Example chat endpoints can echo, branch, or demonstrate request parsing, but they should not import OpenAI, Anthropic, or other LLM SDKs.
