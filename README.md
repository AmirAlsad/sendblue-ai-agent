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

## Operational visibility

The agent ships with a dependency-free observability layer:

- `GET /health` — liveness probe (uptime, version, node version).
- `GET /ready` — readiness probe with Redis ping and buffer-scheduler stats; returns 503 when a dependency is unhealthy.
- `GET /metrics` — Prometheus text exposition (counters, gauges, histograms for webhooks, chat dispatch, outbound sends, status callbacks, retries, SMS-limit stalls, rate-limit pacing).
- `GET /admin/limits`, `/admin/conversations/:key`, `/admin/status/:messageHandle`, `/admin/queue`, `/admin/dedupe?messageHandle=...` — operator introspection. PII redacted by default; pass `?reveal=true` to unmask.
- A request-scoped `traceId` (also surfaced via the `x-trace-id` response header) is stamped on every pino log line. The traceId persists on the conversation record and outbound handle mapping, so a status callback that arrives later carries a `conversationTraceId` chained to the original webhook.

`/metrics` and every `/admin/*` route mount only when `ADMIN_API_TOKEN` is set; the route table is empty when the token is unset, preventing accidental exposure. See [docs/features/operational-visibility.md](docs/features/operational-visibility.md).

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
- [Sendblue contact upsert](docs/features/contact-upsert.md)
- [Agent-plan limit tracking](docs/features/plan-limits.md)
- [Operational visibility (metrics, tracing, health, introspection)](docs/features/operational-visibility.md)
- [Persistence](docs/features/persistence.md)
- [Testing infrastructure](docs/TESTING.md)
- [Observed Sendblue payload structures](docs/SENDBLUE-PAYLOAD-STRUCTURES.md)

## Examples

Try any of the examples locally — no Sendblue account or device required:

```bash
npm run example:chat -- action-catalog        # every action type
npm run example:chat -- scripted-flow         # pizza pickup state machine
npm run example:chat -- minimal-chat-endpoint # echo bot
npm run example:chat -- showcase-bot          # LLM-backed (needs ANTHROPIC_API_KEY)
```

The CLI boots the example in a child process and drops you into a REPL
that posts properly-shaped chat requests and pretty-prints the response.

To exercise the **same examples with real iMessage** to your Sendblue
line — agent + ngrok + webhooks all wired up automatically:

```bash
# .env has SENDBLUE_*, NGROK_AUTHTOKEN, E2E_TEST_DEVICE_NUMBER
npm run example:dev -- showcase-bot
# message your Sendblue line from your device; the bot responds
```

See [examples/README.md](examples/README.md) for the full tour, the REPL
commands (`/sms`, `/reset`, `/raw`), and how the hardware loop is wired.

Examples in [`examples/`](examples/):

- `minimal-chat-endpoint` — smallest possible `CHAT_ENDPOINT_URL` echo bot.
- `identity-lookup` — optional `USER_LOOKUP_URL` resolver.
- `action-catalog` — one labeled handler per chat action type (`message`,
  `media`, `reply`, `reaction`, `silence`, send effects, group routing, SMS
  fallback) plus an XML-tag mode.
- `scripted-flow` — deterministic pizza pickup state machine that walks
  through every action type as a real conversation arc, no LLM.
- `showcase-bot` — reference architecture for a real LLM-backed bot.
  Multi-provider via Vercel AI SDK; tools build the `actions[]` chat
  contract directly. Lives in its own `package.json`.

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

Optional for Sendblue contact upsert (see [docs/features/contact-upsert.md](docs/features/contact-upsert.md)):

- `SENDBLUE_CONTACTS_ENABLED` (defaults to `false`; opt in once your
  `USER_LOOKUP_URL` returns name fields. Group inbound only fires the
  upsert hook on **invoked & authorized** groups.)
- `SENDBLUE_CONTACTS_DEFAULT_TAGS` (comma-separated, defaults empty;
  merge with resolver tags is **case-insensitive** so `'Agent'` +
  `'agent'` collapse to one entry)
- `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS` (defaults to `2592000` — 30
  days; must be `>= 1`, the loader rejects `0`)

Optional for Agent-plan limit tracking and retries (see
[docs/features/plan-limits.md](docs/features/plan-limits.md)):

- `OUTBOUND_RATE_LIMIT_PER_SECOND` (defaults to `1`; `0` disables pacing)
- `OUTBOUND_RATE_LIMIT_PER_HOUR` (defaults to `2000`)
- `OUTBOUND_RATE_LIMIT_PER_DAY` (defaults to `4000`)
- `INBOUND_CONTACTS_PER_DAY_WARN_THRESHOLD` / `INBOUND_CONTACTS_PER_DAY_LIMIT` (defaults `800` / `1000`)
- `FOLLOW_UP_DAILY_WARN_THRESHOLD` / `FOLLOW_UP_DAILY_LIMIT` (defaults `160` / `200`; track-only)
- `REPLY_WINDOW_HOURS` (defaults to `24`)
- `TRANSIENT_RETRY_MAX_ATTEMPTS` / `TRANSIENT_RETRY_BASE_MS` /
  `TRANSIENT_RETRY_MAX_MS` (defaults `3` / `1000` / `60000`; covers
  `5509`/`5003`/`4001`/429/5xx and `httpStatus: 0` network failures.
  `BASE_MS <= MAX_MS` enforced at boot.)
- `SMS_LIMIT_RETRY_INTERVAL_MS` (defaults to `3600000` — 1h, must be
  `>= 1`) / `SMS_LIMIT_MAX_ATTEMPTS` (defaults to `24`, must be `>= 1`;
  the cap is now actually enforced — the agent tracks attempts and
  aborts after exhaustion. Stalls are persisted with `conversationKey`
  so a fresh process can resume scheduled retries on boot via
  `recoverPendingRetries`.)
- `ADMIN_API_TOKEN` (unset = `GET /metrics` and every `/admin/*`
  introspection route — including `/admin/limits` — is **not mounted**;
  set to enable the read-only counter snapshot, Prometheus scrape, and
  redacted-by-default introspection endpoints. Token compared via
  `crypto.timingSafeEqual`; either `Authorization: Bearer <token>` or
  `x-admin-api-token: <token>` is accepted.)

Optional for operational visibility (see
[docs/features/operational-visibility.md](docs/features/operational-visibility.md)):

- `METRICS_LABEL_CARDINALITY_LIMIT` (defaults to `1000`; per-metric guardrail
  before excess label combinations fold into a `__overflow__` sentinel series)
- `READY_REDIS_TIMEOUT_MS` (defaults to `500`; timeout on the Redis ping
  issued by `GET /ready`. When `REDIS_URL` is unset, `/ready` short-circuits
  with `{ kind: "in_memory" }`.)

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

`probe:contacts` is the create-contact equivalent: it calls
`POST /api/v2/contacts` (upsert) with `E2E_TEST_DEVICE_NUMBER` and a
clearly-tagged `Probe Test` payload, then attempts a follow-up
`DELETE /api/v2/contacts/{phone}` to clean up. Useful for confirming the
exact body shape Sendblue accepts (the live response keys the nested
contact's phone as `phone`, not `number`) and for sanity-checking the
Contacts API on a new account before flipping `SENDBLUE_CONTACTS_ENABLED=true`.

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
