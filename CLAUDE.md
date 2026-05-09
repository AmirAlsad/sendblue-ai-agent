# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Scope

`sendblue-ai-agent` is a transport/orchestration package — Sendblue webhook ingestion, outbound delivery, status tracking, dedupe, conversation buffering, and ordered delivery for an iMessage AI agent. The developer brings their own HTTP chat endpoint. The transport package itself stays model-provider-free: do not couple `src/` to a model provider, add LLM-specific assumptions to the chat contract, or pull OpenAI/Anthropic/etc. SDKs into the root `package.json`. Example subdirectories under `examples/` with their own `package.json` may bring any provider — `examples/showcase-bot/` is the canonical case.

`AGENTS.md` is the durable project guidance (intent, version roadmap, Sendblue constraints, testing strategy, implementation rules). Read it before non-trivial changes — it lists API quirks (status callbacks, downgrades, group routing, error codes) that the code intentionally relies on.

## Commands

```bash
npm test              # unit + integration (hardware-free, what CI should run)
npm run test:unit     # tests/unit only
npm run test:integration   # tests/integration only
npm run typecheck     # tsc --noEmit
npm run build         # tsc -p tsconfig.build.json -> dist/
npm run dev           # runs src/index.ts via tsx; needs .env (autostarts on import)
```

Run a single test file: `npx vitest run --config vitest.config.ts tests/unit/sendblue-parser.test.ts`
Run a single test by name: add `-t "<name>"`.

E2E (real Sendblue line + macOS Messages.app + ngrok required, **never run in CI**):

```bash
npm run setup:e2e        # creates gitignored .env if missing
npm run verify:e2e       # checks ngrok/macOS/Messages/Sendblue prereqs without sending
npm run dev:e2e          # local agent + deterministic chat endpoint + ngrok + webhook registration
npm run sendblue:webhooks    # register receive/outbound webhooks; -- --all for every type
npm run capture:fixtures # capture server -> .captures/sendblue/
npm run capture:guided   # guided capture session driving E2E_TEST_DEVICE_NUMBER
npm run showcase:e2e     # live scenario showcase, writes .captures/sendblue-showcase/
npm run probe:sendblue   # one-shot diagnostic: calls /api/mark-read against E2E_TEST_DEVICE_NUMBER and reports the response (no messages sent, no webhook config mutated)
npm run probe:contacts   # one-shot diagnostic: POST /api/v2/contacts (upsert) for E2E_TEST_DEVICE_NUMBER then DELETE to clean up. Confirms Sendblue accepts the createContact body shape.
npm run test:e2e         # vitest with vitest.e2e.config.ts (sequential, 90s timeout)
```

`src/index.ts` autostarts the server on import unless `AGENT_AUTOSTART=0` or `NODE_ENV=test`. Keep that gate in mind when wiring new entry points.

## Architecture

The runtime is a single Express app composed in `src/http/app.ts`. `createApp(deps)` wires:

- `parseReceiveWebhook` / `parseStatusWebhook` / `parseTypingIndicatorWebhook` (`src/sendblue/parser.ts`) at the route boundary.
- `validateWebhookSecret` (`src/http/security.ts`) gates every webhook route using `crypto.timingSafeEqual`. Sendblue documents the header as `sb-signing-secret` (https://docs.sendblue.com/security) — a literal shared-secret string, not an HMAC over the body. `SENDBLUE_WEBHOOK_SECRET_HEADER` remains configurable as a compatibility alias for legacy installs.
- `ConversationAgent` (`src/conversation/agent.ts`) — the central state machine. Owns inbound dedupe, group routing, buffering, the chat call, ordered outbound delivery, typing refreshes, status-driven queue advancement, the optional read-receipt API call, the optional Sendblue contact upsert hook, and the transient-retry / SMS-limit-stall paths layered on `LimitTracker`.
- `ChatClient` (`src/chat/client.ts`) — HTTP POST to the developer's `CHAT_ENDPOINT_URL`. `normalizeChatResponse` collapses legacy (`message` / `messages` / `silence`), XML-tagged, and rich `actions[]` responses into a single normalized form.
- `SendblueClient` (`src/sendblue/client.ts`) — outbound `send-message`, group send, reactions, `mark-read`, typing indicator, `create-contact`. Each `send-message` includes its own `status_callback`; there is no global default. Non-2xx responses throw `SendblueApiError` exposing `operation`, `httpStatus`, `errorCode`, `serverMessage`, `responseBody` so callers can branch on documented codes (`5509` rate limit, `SMS_LIMIT_REACHED`, etc.) without regexing message strings.
- Status flow: `applyStatusUpdate` (`src/status/tracker.ts`) accumulates history; `ConversationAgent.handleStatus` advances the per-conversation outbound queue. Transient `errorCode` callbacks (rate-limit / server / `httpStatus: 0` network failures) trigger bounded retry; `SMS_LIMIT_REACHED` triggers a per-line stall via `SmsLimitStallScheduler`. Both retry paths capture `{ itemId, retryCount }` at scheduling time and the timer-driven `runRetry` drops stale attempts whose queue has advanced. `interruptSending`/`transitionToIdle` cancel pending retry/stall timers + persisted stall metadata; `advanceQueue` clears the stall on the next successful `DELIVERED`/`SENT`.
- `IdentityResolver` (`src/identity/resolver.ts`) is optional enrichment over `USER_LOOKUP_URL`, fail-open. Returned `firstName`/`lastName`/`tags`/`customVariables` feed the optional Sendblue contact upsert hook.
- `LimitTracker` (`src/limits/tracker.ts`) — pre-emptive 1/s pacing, distinct-inbound + 24h-reply-window tracking, `classifyError`/`classifyStatusErrorCode` for retry routing. Backed by `LimitCounterStore` (in-memory or Redis) and `SmsLimitStallScheduler`. Emits `acquire_send_slot_delay_seconds` and `limit_threshold_crossings_total` metrics when wired.
- Operational visibility (`src/metrics/`, `src/http/trace.ts`, `src/http/redaction.ts`):
  - `MetricsCollector` (`InMemoryMetricsCollector` + `NoopMetricsCollector`) primitives with per-metric label-cardinality cap. `createAgentMetrics` registers ~17 named counters/histograms/gauges; `renderPrometheus` emits standard text format.
  - `traceMiddleware` issues per-request `traceId` (echoed in `x-trace-id`), stores it on `res.locals`, and feeds a pino child logger into `ConversationAgent.handle*` calls. The traceId persists on `ConversationRecord` and `OutboundHandleMapping` so status callbacks recover the original conversation trace as `conversationTraceId`. BullMQ buffer jobs carry the traceId on the payload.
  - HTTP routes: `GET /health` (liveness), `GET /ready` (Redis ping + scheduler stats; returns 503 on dependency failure), `GET /metrics` (Prometheus, token-gated), and the admin introspection set: `GET /admin/limits`, `GET /admin/conversations/:key`, `GET /admin/status/:messageHandle`, `GET /admin/queue`, `GET /admin/dedupe?messageHandle=...`. PII redacts by default; `?reveal=true` unmasks. All admin routes share `ADMIN_API_TOKEN` via the shared `validateAdminToken` (`src/http/auth.ts`); none mount when the token is unset.

### Conversation state — load-bearing rules

- Direct keys: `direct:{sendblueLine}:{phoneNumber}`. Group keys: `group:{sendblueLine}:{groupId}`. **One record across iMessage/RCS/SMS/downgrade** — do not split by service.
- Buffering: rapid inbound bursts are aggregated into a backward-compatible top-level `message` string **plus** structured `messages[]`. Timer math lives in `src/conversation/buffering.ts`; storage in `src/conversation/store.ts` (in-memory) and `src/conversation/redis-store.ts`.
- Scheduler: `InMemoryBufferScheduler` for tests/local, `BullMqBufferScheduler` for production. Selection is driven by `REDIS_URL` in `createApp`.
- Ordered delivery is **channel-aware**: iMessage/RCS queues advance on `DELIVERED`; SMS and downgraded queues advance on `SENT`. `was_downgraded` is conversation-significant state — preserve it.
- Groups are silent unless addressed to `AGENT_DISPLAY_NAME`, reference a known agent outbound, or future payloads include explicit reply metadata. Always ack/dedupe/log; only reply by `group_id` for addressed inbound-initiated groups.
- Per-feature channel support (verified 2026-05-07 against Sendblue docs):
  - **iMessage only**: Tapback reactions (`/api-v2/reactions/`), outbound typing indicators (`/api-v2/typing-indicators/`), send effects (`send_style`). Suppress/degrade on RCS, SMS, downgraded.
  - **iMessage + RCS** (not SMS): read receipts (`POST /api/mark-read`, `/api-v2/read-receipts/`).
  - **All channels**: text, media (`media_url` — auto-compressed to ≤5 MB MMS on SMS downgrade).
  - Sendblue has **no routing override** on `/api/send-message` — `was_downgraded` on the request is silently ignored. iMessage-capable numbers always receive iMessage; Apple queues if the device is offline. Do not add `force_sms`-style code paths.
  - Per-message `status_callback` URLs arrive unsigned. `/webhook/status` uses `validateStatusCallbackSecret` (lenient); receive/typing/operational use `validateWebhookSecret` (strict).
- `was_downgraded` is conversation-significant but **not sticky for life**: clears when a fresh `service: "iMessage"` receive arrives so iMessage-only features re-engage.
- Reply intent is preserved through the chat contract but currently sends as a normal message — Sendblue direct sends do not expose a native reply target parameter.
- Read receipts are best-effort `POST /api/mark-read` (gated by `READ_RECEIPTS_ENABLED`) and account-gated by Sendblue (contact support@sendblue.com to enable). There is no `READ` status callback. Do not assume one.

### Chat contract

Preserve the legacy top-level `message` string and `messages[]`/`silence` response forms for backward compatibility. New behavior goes through `actions[]` (`src/chat/types.ts`, normalization in `src/chat/contract.ts`). XML tag parsing (`parseTaggedText`) is a compatibility bridge for tagged model output — normalize tags into `actions[]`, do not expose XML as a transport abstraction. Identity, conversation, and typing context are added as structured request fields, not by replacing existing ones.

### Persistence

With `REDIS_URL`: conversation state, dedupe (`SET NX` with `DEDUPE_TTL_SECONDS`), outbound-handle → conversation-key map, BullMQ-delayed buffer processing, contact-upsert dedupe (`sendblue-ai-agent:contact-upserted:*`), and the limit counter family (`sendblue-ai-agent:limits:*` — outbound rate buckets, distinct-inbound sets, follow-up counters, last-inbound-at, the Lua-managed pacing slot, and SMS-stall metadata). **This is the production path.** Without it, in-memory maps and timers are used for tests and local smoke runs only — state is per-process and disappears on restart, and the per-line pacer overshoots in multi-replica deploys.

### Sendblue webhook surface

`src/sendblue/webhook-types.ts` lists `receive`, `outbound`, `typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, `contact_created`. Operational types share a generic handler; `typing_indicator` has its own route because some accounts reject or drop registration even though the docs list it — keep that path in place but treat the feature as account-gated.

### Optional features

- **Sendblue contact upsert** — gated by `SENDBLUE_CONTACTS_ENABLED` (default off). When enabled, inbound from numbers with a resolver-supplied name fires a fire-and-forget `POST /api/v2/contacts` with `update_if_exists: true`. **Direct inbound:** upserts the from-number. **Group inbound:** iterates `participants[]` only when the group is invoked (`@AGENT_DISPLAY_NAME` mention or known agent outbound reference) AND, with `VALID_USER_REQUIRED=true`, the invoker is authorized — non-invoked / unauthorized groups return early before the upsert hook. Per-(line, number) dedupe SETNX with `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS` (default 30 days, `>= 1` enforced) prevents re-burning the contacts API on every inbound. Tag dedup is case-insensitive. See `docs/features/contact-upsert.md`.
- **Agent-plan limit tracking** — counters always run when a tracker is wired (default in `createApp`). Pre-emptive 1/s pacing via `LimitTracker.acquireSendSlot` before every direct/group send. Transient errors (`5509`/`5003`/`4001`/429/5xx and `httpStatus: 0` network failures) retry with exponential backoff (1s/4s/16s, capped at `TRANSIENT_RETRY_MAX_MS`); `SMS_LIMIT_REACHED` stalls the per-line queue via the scheduler with write-through persistence (`setSmsLimitStall`) and is capped at `SMS_LIMIT_MAX_ATTEMPTS`. `GET /admin/limits` exposes live counters when `ADMIN_API_TOKEN` is set; otherwise the route is **not mounted** at all. See `docs/features/plan-limits.md`.
- **Boot-time replay** — `ConversationAgent.recoverPendingRetries()` enumerates persisted SMS stalls via `LimitCounterStore.listSmsLimitStalls()` (Redis SCAN) and conversation records in `'sending'` state with `nextRetryAt`/`retryCount` via `ConversationStore.listConversationKeys()`, then re-arms in-process timers with the remaining delay. `createApp()` calls it non-blocking; failures log warn and never gate startup. In-memory store is a no-op (per-process state vanishes on restart).
- **Boot-time config validation** — `loadConfig` throws if `*_WARN_THRESHOLD > *_LIMIT` for inbound/follow-up pairs, `OUTBOUND_RATE_LIMIT_PER_HOUR > OUTBOUND_RATE_LIMIT_PER_DAY`, or `TRANSIENT_RETRY_BASE_MS > TRANSIENT_RETRY_MAX_MS`. Zero-valued TTLs/intervals (`SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS`, `SMS_LIMIT_RETRY_INTERVAL_MS`, `SMS_LIMIT_MAX_ATTEMPTS`) are also rejected.

## Conventions

- TypeScript ESM (`"type": "module"`). Imports of internal `.ts` files use `.js` specifiers (Node ESM resolution).
- Node `>=20`. Vitest for tests; `node-mocks-http` for Express handler tests; injected fakes for chat/Sendblue/identity in `tests/integration`.
- Structured logging with `pino`. Include enough fields to debug webhook delivery, Sendblue API responses, and chat endpoint failures.
- Capture artifacts (`.captures/`) and `.env` are gitignored and may contain phone numbers, tunnel URLs, message content, and secrets — manually redact before promoting captures into `tests/fixtures/sendblue/captured/`.
- New feature docs follow `docs/features/<name>.md`: what it does, how it works, code files, configuration, known limitations.
