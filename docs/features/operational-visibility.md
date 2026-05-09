# Operational Visibility

## What it does

Adds the operational surface needed to run the agent in production:

- A Prometheus-compatible `/metrics` endpoint (token-gated).
- A request-scoped `traceId` propagated through every webhook, persisted on
  the conversation record + outbound handle mapping, and chained back into
  status-callback log lines so a single iMessage round trip is traceable
  end-to-end without external tracing infrastructure.
- An extended `/health` (liveness, fast) and a new `/ready` (dependency
  checks, may issue Redis ping).
- Token-gated introspection routes — `/admin/conversations/:key`,
  `/admin/status/:messageHandle`, `/admin/queue`, `/admin/dedupe` — with PII
  redacted by default; pass `?reveal=true` to unmask.

No npm dependencies were added. Metrics are an in-memory implementation with
a hand-rolled Prometheus text-format renderer; tracing builds on the existing
pino logger via child loggers.

## How it works

### Metrics

`MetricsCollector` (`src/metrics/collector.ts`) declares three primitives —
`Counter`, `Gauge`, `Histogram`. Two implementations ship:

- `InMemoryMetricsCollector` — keeps per-label-combination state in-process,
  protected by a per-metric cardinality cap (default 1000; overflow folds
  into a `__overflow__` sentinel series and emits one warn log).
- `NoopMetricsCollector` — used when `metrics` is omitted from `createApp`,
  so existing tests and integrations stay unchanged.

`createAgentMetrics(collector)` (`src/metrics/registry.ts`) builds the named
metric handles instrumented across the codebase. The metrics surface is
deliberately tight (≈15 metrics); labels carry the dimensions:

| Metric | Type | Labels |
|---|---|---|
| `webhook_received_total` | counter | `type, result` |
| `webhook_secret_rejections_total` | counter | `route` |
| `webhook_parse_failures_total` | counter | `type, reason` |
| `webhook_dedupe_total` | counter | `result` |
| `chat_dispatch_duration_seconds` | histogram | `result` |
| `outbound_send_duration_seconds` | histogram | `operation, result` |
| `outbound_send_total` | counter | `operation, channel, result, error_code` |
| `transient_retry_total` | counter | `action, outcome` |
| `sms_limit_stall_total` | counter | `event` |
| `delivery_timeout_fired_total` | counter | (none) |
| `status_callback_total` | counter | `status, channel, error_category` |
| `status_to_terminal_seconds` | histogram | `terminal, channel` |
| `acquire_send_slot_delay_seconds` | histogram | `line_number` |
| `limit_threshold_crossings_total` | counter | `kind, level` |
| `buffer_jobs_total` | counter | `event` |
| `agent_up` | gauge | (none) |
| `agent_build_info` | gauge | `version` |

`error_code` is normalized to a known-set + `other` to keep cardinality bounded
(`normalizeErrorCodeLabel` in the registry). `line_number` labels are accepted
because production deployments use one Sendblue line per agent instance.
Conversation-key, message-handle, and phone-number labels are forbidden — they
go in logs (correlated by traceId), never in metrics.

`renderPrometheus(snapshot)` (`src/metrics/prometheus.ts`) emits the standard
Prometheus exposition format with `# HELP` / `# TYPE` lines and cumulative
histogram buckets including the implicit `+Inf` bucket.

`GET /metrics` mounts only when `ADMIN_API_TOKEN` is set, gated by the same
`validateAdminToken` (`src/http/auth.ts`) used by `/admin/*`.

### Tracing

`traceMiddleware(deps: { logger })` (`src/http/trace.ts`) is mounted via
`app.use` after the JSON parser. For each request it:

- Reads `x-trace-id` if present and well-formed; otherwise generates a UUID.
- Stores `traceId` and a pino child logger on `res.locals`.
- Echoes `x-trace-id` back in the response header.

Each webhook route plucks the `RequestContext` via `requestContextFromLocals(res)`
and passes it into `ConversationAgent.handleReceive`/`handleStatus`/`handleTyping`.
The agent persists `traceId` on the `ConversationRecord` (so a buffer flush
fired by BullMQ later can re-create the same child logger) and on the
`OutboundHandleMapping` (so a status callback later can resurrect the original
conversation traceId and chain it as `conversationTraceId` in the log line).

### /health and /ready

`GET /health` is intentionally cheap and unauthenticated. It returns
`{ ok, uptime_s, version, node_version }`. Use it for liveness.

`GET /ready` may take ≤ 500 ms (configurable via `READY_REDIS_TIMEOUT_MS`):

```json
{
  "ok": true,
  "started_at": "2026-05-08T...",
  "redis": { "ok": true, "kind": "redis", "latency_ms": 4 },
  "scheduler": { "ok": true, "kind": "bullmq", "stats": { "active": 0, "waiting": 1, "delayed": 0, "failed": 0 } }
}
```

Returns 503 when any dependency check fails. When `REDIS_URL` is unset the
redis block reports `{ ok: true, kind: 'in_memory' }`. Use it for readiness.

### /admin introspection

All admin routes share `ADMIN_API_TOKEN` and the `validateAdminToken` helper.
None mount when the token is unset. PII fields redact by default; `?reveal=true`
returns the full record.

- `GET /admin/conversations/:key` — fetch a `ConversationRecord`.
- `GET /admin/status/:messageHandle` — fetch a `StatusRecord` with full
  callback history.
- `GET /admin/queue` — buffer scheduler counts (`active`, `waiting`,
  `delayed`, `failed` for BullMQ; `pending` for in-memory).
- `GET /admin/dedupe?messageHandle=...` — non-destructive presence check on
  the inbound dedupe set, returning `{ messageHandle, present, ttl_s? }`.

`src/http/redaction.ts` masks phone numbers (preserving leading `+` and the
last four digits), replaces message content with a `[redacted len=N]`
sentinel, and recursively redacts conversation/status records.

## Code files

- `src/metrics/collector.ts` — `MetricsCollector` interface, in-memory and
  noop implementations, label-cardinality protection.
- `src/metrics/prometheus.ts` — text-format renderer.
- `src/metrics/registry.ts` — named metric handles + `normalizeErrorCodeLabel`.
- `src/http/trace.ts` — `traceMiddleware` + `RequestContext`.
- `src/http/auth.ts` — shared `validateAdminToken` and timing-safe comparison.
- `src/http/redaction.ts` — phone/content/record redaction helpers.
- `src/http/admin.ts` — `/admin/*` route handlers.
- `src/http/app.ts` — wires metrics, tracing, `/metrics`, `/health`, `/ready`.
- `src/conversation/types.ts` — `traceId?` on `ConversationRecord` and
  `OutboundHandleMapping`.
- `src/conversation/scheduler.ts` — `BufferScheduler.kind` + `getStats()`,
  `buffer_jobs_total` instrumentation, traceId rehydration on job dispatch.
- `src/conversation/agent.ts` — RequestContext threading, metric calls on
  webhook ingest, chat dispatch, outbound send, transient retry, SMS-limit
  stall, delivery timeout, status callback.
- `src/limits/tracker.ts` — `acquire_send_slot_delay_seconds` histogram and
  `limit_threshold_crossings_total` counter.

## Configuration

```bash
# Mounts /metrics and /admin/* (default off — when unset, none of these are mounted).
ADMIN_API_TOKEN=...

# Hard cap on label combinations stored per metric before overflow folds into
# a sentinel series. Default 1000.
METRICS_LABEL_CARDINALITY_LIMIT=1000

# Timeout (ms) for the Redis ping issued by /ready. Default 500.
READY_REDIS_TIMEOUT_MS=500
```

`LOG_LEVEL` (existing) controls the base pino level; child loggers carrying
`traceId` inherit the level.

## Known limitations

- `acquire_send_slot_delay_seconds` and `limit_threshold_crossings_total`
  emit the bare line number as a label. With one Sendblue line per agent
  instance this is fine; multi-line operators must monitor cardinality.
- The metrics collector is in-process. Two horizontally-scaled replicas have
  independent counters; aggregation must happen at the scrape layer.
- TraceID propagation is single-process. Distributed propagation across a
  worker-separated deployment will need to ride a future architectural
  change (the traceId on the BullMQ payload already covers the
  HTTP-process → worker-process hop, but multi-replica HTTP currently does
  not chain).
- `/admin/dedupe` performs a non-destructive `EXISTS` + `TTL` on Redis
  (`peekInboundHandle`); it does not enumerate the dedupe set. Use the
  scrape data, not this endpoint, for population-level analysis.
