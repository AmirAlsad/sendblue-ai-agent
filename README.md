# sendblue-ai-agent

Messaging infrastructure for deploying an AI agent over iMessage with Sendblue.

This package is intentionally transport and orchestration focused. The developer
brings a chat endpoint; this package handles Sendblue webhook ingestion, outbound
delivery, status tracking, deduplication, and conversation intelligence.

## Current Foundation

The root package is scaffolded as TypeScript ESM with Vitest test infrastructure:

```bash
npm test
npm run setup:e2e
npm run verify:e2e
npm run dev:e2e
npm run capture:fixtures
npm run capture:guided
npm run probe:sendblue
npm run test:e2e
npm run typecheck
```

`npm test` runs hardware-free unit and integration tests. The repo owns the
E2E orchestration scripts, but `npm run test:e2e` still requires a real Sendblue
line, Messages.app on macOS, read access to `~/Library/Messages/chat.db`, and
an ngrok tunnel.

## Conversation Intelligence

The v0.2 runtime buffers rapid direct-message bursts, calls the chat endpoint
with both an aggregated `message` string and structured `messages[]`, sends
agent replies through an ordered per-conversation queue, and advances that queue
from Sendblue status callbacks. iMessage/RCS queues advance on `DELIVERED`;
SMS/downgraded queues advance on `SENT`.

The rich capability contract keeps the v0.2 `message`, `messages`, and
`silence` response forms, and adds `actions[]` for hosted media, send effects,
reactions, reply intent, silence, and addressed group replies. Direct reply
intent is preserved for chat endpoints but currently sends as a normal Sendblue
message because Sendblue direct sends do not expose a native reply target
parameter. Read receipts and typing refreshes are best-effort agent-side API
calls around chat processing and ordered delivery. XML-style tags are documented
as a compatibility layer for chat endpoints that produce tagged text instead of
structured JSON.

Direct conversations are keyed as `direct:{sendblueLine}:{phoneNumber}`. Group
messages are silent unless the message is addressed to `AGENT_DISPLAY_NAME` or
references a known agent outbound. Unaddressed groups continue to be
acknowledged and deduped without calling the chat endpoint.

When `REDIS_URL` is configured, state and buffer timers use Redis/BullMQ. Without
Redis, the package uses in-memory state for local development and tests. Redis is
the production path for durable buffering, dedupe, and queue state.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Configuration and tunables](docs/features/configuration.md)
- [Inbound webhooks](docs/features/inbound-webhooks.md)
- [Outbound Sendblue client](docs/features/outbound-client.md)
- [Webhook security](docs/features/webhook-security.md)
- [Message buffering and interruptions](docs/features/message-buffering.md)
- [Ordered delivery](docs/features/ordered-delivery.md)
- [Status tracking](docs/features/status-tracking.md)
- [Typing indicators](docs/features/typing-indicators.md)
- [Identity resolver](docs/features/identity-resolver.md)
- [Conversation state and chat contract](docs/features/conversation-state.md)
- [Rich chat actions](docs/features/rich-chat-actions.md)
- [Testing infrastructure](docs/TESTING.md)
- [Observed Sendblue payload structures](docs/SENDBLUE-PAYLOAD-STRUCTURES.md)

## Examples

Runnable local examples live in [examples](examples/):

- `examples/minimal-chat-endpoint` - smallest possible `CHAT_ENDPOINT_URL`.
- `examples/identity-lookup` - optional `USER_LOOKUP_URL` resolver.
- `examples/v02-rich-chat-endpoint` - consumes buffered messages, conversation
  metadata, identity, typing state, and SMS downgrade state.
- `examples/rich-actions-chat-endpoint` - demonstrates `actions[]`, XML tag
  compatibility, silence, reactions, replies, hosted media, send effects, and
  addressed group behavior.

## Environment

Copy `.env.example` to `.env` and set the values for local development.

Required for the agent:

- `PUBLIC_BASE_URL`
- `CHAT_ENDPOINT_URL`
- `SENDBLUE_API_KEY_ID`
- `SENDBLUE_API_SECRET_KEY`
- `SENDBLUE_FROM_NUMBER` (must be valid E.164 — leading `+` then 10–15 digits, e.g. `+15551234567`. Invalid values throw at `loadConfig` startup so a `.env` typo fails fast instead of silently 400ing the first Sendblue call.)

Optional for webhook secret validation:

- `SENDBLUE_WEBHOOK_SECRET`
- `SENDBLUE_WEBHOOK_SECRET_HEADER` (defaults to `sb-signing-secret`)

Optional for conversation intelligence:

- `REDIS_URL`
- `BUFFER_BASE_TIMEOUT_MS` (defaults to `2000`)
- `BUFFER_GROWTH_FACTOR` (defaults to `1.25`)
- `BUFFER_MAX_TIMEOUT_MS` (defaults to `8000`)
- `BUFFER_NOISE_MAX_DEVIATION` (defaults to `0.3`)
- `MAX_REPROCESS_ATTEMPTS` (defaults to `2`)
- `OUTBOUND_DELIVERY_TIMEOUT_MS` (defaults to `30000`)
- `USER_LOOKUP_URL`
- `OUTBOUND_TYPING_INDICATORS_ENABLED` (defaults to `true`)
- `INBOUND_TYPING_STATE_ENABLED` (defaults to `true`)

Optional for rich Sendblue actions:

- `CHAT_RESPONSE_PARSE_TAGS` (defaults to `true`)
- `CHAT_RESPONSE_MESSAGE_TAG` (defaults to `message`)
- `CHAT_RESPONSE_NO_RESPONSE_TAG` (defaults to `no_response`)
- `CHAT_RESPONSE_REACTION_TAG` (defaults to `reaction`)
- `CHAT_RESPONSE_REPLY_TAG` (defaults to `reply`)
- `READ_RECEIPTS_ENABLED` (defaults to `false`; gates best-effort
  `POST /api/mark-read` calls. Per Sendblue's docs read receipts work for
  iMessage **and RCS** (not SMS or downgraded). The feature is also account-
  gated by Sendblue — contact support@sendblue.com to enable. There is no
  `READ` status callback.)
- `READ_RECEIPT_DEBOUNCE_MS` (defaults to `250`)
- `TYPING_REFRESH_INTERVAL_MS` (defaults to `5000`)
- `TYPING_REFRESH_MAX_MS` (defaults to `120000`)
- `AGENT_DISPLAY_NAME` (defaults to `sb-agent`)
- `VALID_USER_REQUIRED` (defaults to `false`)

Required only for E2E:

- `E2E_AGENT_PORT`
- `E2E_PUBLIC_BASE_URL` (optional override; normally generated by ngrok)
- `E2E_TEST_DEVICE_NUMBER`
- `E2E_MESSAGES_DB_PATH` (optional, defaults to `~/Library/Messages/chat.db`)
- `NGROK_AUTHTOKEN`
- `NGROK_DOMAIN` (optional, for a reserved stable ngrok domain)
- `SHOWCASE_MEDIA_URL` (optional public HTTPS asset for `showcase:e2e`)
- `SHOWCASE_READ_TYPING_DELAY_MS` (optional slow response delay for the
  read-receipt/typing showcase step; defaults to `15000`)
- `SHOWCASE_BUFFER_BASE_TIMEOUT_MS`, `SHOWCASE_BUFFER_GROWTH_FACTOR`,
  `SHOWCASE_BUFFER_MAX_TIMEOUT_MS`, and `SHOWCASE_BUFFER_NOISE_MAX_DEVIATION`
  tune the live buffering demo without changing normal agent buffer settings.
- `SHOWCASE_TYPING_REFRESH_INTERVAL_MS` and `SHOWCASE_TYPING_REFRESH_MAX_MS`
  tune the dedicated outbound typing demo.

Run `npm run setup:e2e` to create a local gitignored `.env` file if one does
not already exist. The repo scripts load `.env` for both agent and real-device
E2E settings.

## Webhooks

`npm run sendblue:webhooks` configures Sendblue to call:

- `POST {PUBLIC_BASE_URL}/webhook/receive`
- `POST {PUBLIC_BASE_URL}/webhook/status`

Use `npm run sendblue:webhooks -- --all` for capture sessions that should also
register `typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, and
`contact_created` callbacks.

The webhook secret header name is configurable. Sendblue documents
`sb-signing-secret`, and captured real webhooks should be kept as fixtures before
enforcing a production secret policy.

## Repo-Managed E2E

Use:

```bash
npm run setup:e2e
npm run verify:e2e
npm run dev:e2e
npm run capture:fixtures
npm run capture:guided
npm run showcase:e2e
npm run probe:sendblue
```

`setup:e2e` creates `.env` if needed. `verify:e2e` checks the ngrok auth token,
native macOS Messages prerequisites, and Sendblue API reachability without
sending messages. `dev:e2e` starts the local agent, deterministic chat endpoint,
ngrok tunnel through the JavaScript SDK, and registers Sendblue webhooks.

`capture:fixtures` starts a local capture server for message, status, and
operational webhook paths and writes raw request envelopes to
`.captures/sendblue/`. Redact captures manually before moving stable examples
into `tests/fixtures/sendblue/captured/`.

`capture:guided` starts the same capture server, opens an ngrok SDK tunnel,
registers Sendblue webhooks, and sends step-by-step instructions to
`E2E_TEST_DEVICE_NUMBER` for media, tapbacks, send effects, group messages, and
SMS fallback captures. It advances when the expected webhook arrives; reply
`skip` to move past a scenario. It also registers operational webhook types so
incidental callbacks are saved. Each captured envelope is annotated with the
active scenario before being written to `.captures/sendblue/`.

Use `npm run capture:guided -- --list` to show scenario IDs, or run a focused
capture with `npm run capture:guided -- --only tapback-custom-emoji,group-message`.
Observed payload structures are summarized in `docs/SENDBLUE-PAYLOAD-STRUCTURES.md`.

`probe:sendblue` is a one-shot diagnostic that calls `POST /api/mark-read`
against `E2E_TEST_DEVICE_NUMBER` and prints the response (success shape or
`SendblueApiError` body). Useful for verifying the read-receipt account flag
after support enables it, or for catching `from_number` typos that survive
`requireEnv` but fail Sendblue's E.164 check. Sends no outbound message and
mutates no webhook config; a successful call does deliver a UI-visible read
receipt to the recipient's device.

`showcase:e2e` starts a live scenario-aware chat endpoint, the agent, ngrok,
and managed Sendblue webhooks, then sends guided prompts to
`E2E_TEST_DEVICE_NUMBER`. Each step asks for a user action and the agent replies
with what it understood. It writes raw webhook captures and `summary.json` under
`.captures/sendblue-showcase/<session>/`. Reply `skip` to move past optional
group, SMS, custom Tapback, or hosted-media steps. Set `SHOWCASE_MEDIA_URL` to
make the outbound media step send a real hosted asset. The runner also attempts
to register and verify Sendblue's documented `typing_indicator` webhook; if the
live account API rejects or drops it, the diagnostic is written to `summary.json`
and outbound typing indicators are still exercised.

Treat `typing_indicator` as documented but not universally available until the
account's webhook API accepts and persists it. The package keeps the local route,
parser, and chat request enrichment in place so deployments can use inbound
typing when Sendblue enables or exposes the webhook type for the line.

`test:e2e` also starts its own ngrok SDK tunnel and registers Sendblue webhooks
unless `E2E_PUBLIC_BASE_URL` is set to an externally managed URL. Rich action
scenario placeholders live behind `npm run test:e2e`; real-device promotion
should verify hosted media delivery, send effects, reactions, replies, read
receipts, typing refresh cancellation, and addressed group routing.

The repo cannot grant macOS Full Disk Access, sign into Messages.app, approve
Automation prompts, or create an ngrok account/token. Those one-time
host/account permissions still need to be completed on the Mac.
