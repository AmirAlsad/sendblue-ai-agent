# Sendblue Agent-Plan Limit Tracking

## What it does

Tracks the per-line limits Sendblue documents for the Agent plan, paces
outbound to stay below the 1 msg/sec rate, and retries transient errors
(`5509`, `5003`, `4001`, generic 429/5xx) with bounded backoff instead of
aborting the conversation queue. On `SMS_LIMIT_REACHED` the per-line queue
stalls and resumes on a configurable interval. A read-only
`GET /admin/limits` endpoint exposes a counter snapshot for operator
telemetry.

The feature is **default on** for retries (transient errors no longer abort
the queue), and **default off** for the admin endpoint (it only mounts when
`ADMIN_API_TOKEN` is set).

## How it works

### Counters

Per-line counters tracked in `LimitCounterStore`:

- **outbound rate** — second / hour / day buckets. Hour and day buckets are
  warn-logged at 80% and error-logged when the configured limit is reached.
- **distinct inbound contacts today** — `SADD`/`SCARD` per (line, day). Warn
  + error logs at the configured thresholds.
- **follow-ups today** — outbound classified as out-of-window (the
  `last_inbound_at` for that (line, number) is older than `replyWindowHours`).
  **Track-only**: warn at 80%, error on hit, but sends are not gated.
- **24h reply window** — `last_inbound_at` per (line, number) drives the
  in-window vs follow-up classification.
- **SMS-limit stall** — when active, the per-line stall metadata
  (`{ attempts, nextRetryAt, conversationKey }`) is persisted to the
  store. `smsLimitStallAttempts` on `/admin/limits` reflects the live
  counter:
  - Increments to `1` on the first `SMS_LIMIT_REACHED` for a line, then
    bumps each subsequent stall while the cap is not exceeded.
  - Reads back `0` (and the stall key disappears) once the next
    `DELIVERED`/`SENT` advances the queue, when an interrupt cancels
    the stall, or when `smsLimitMaxAttempts` is exceeded.
  - With `REDIS_URL` configured, a fresh process picks the stall back
    up on boot via `recoverPendingRetries`. Without Redis, restart
    silently drops the stall (in-memory).

### Pacing

`LimitTracker.acquireSendSlot(lineNumber)` is called immediately before every
outbound `sendMessage` / `sendGroupMessage`. The token-bucket gate computes
the next allowed slot and the call awaits the required delay before
returning. With `OUTBOUND_RATE_LIMIT_PER_SECOND=1` (default), the second
back-to-back send waits ~1 second.

The Redis-backed store uses an `EVAL` Lua script for atomic
compare-and-set, so multi-replica deploys still respect 1/s on the line.
The in-memory store is per-process and overshoots in multi-replica setups —
configure `REDIS_URL` for production.

### Retry on transient errors

When a Sendblue status callback or synchronous send error has an `errorCode`
classified as `rate_limit` or `server` (`5509`, `5003`, `4001`, `5000`,
`status_unresolved`, or any 429 / 5xx — or `httpStatus: 0` network failure —
without a documented code), the agent:

1. Clears the failed send's metadata (`messageHandle`, `sentAt`).
2. Bumps `outboundQueue[index].retryCount` and persists the conversation.
3. Captures `{ itemId: item.id, retryCount }` and schedules a retry via
   `setTimeout(retryDelayMs(attempt), ...)`. The schedule is exponential
   with ±20% jitter: ~1s / 4s / 16s, capped at 60s.
4. When the timer fires, `runRetry` re-loads the conversation and verifies
   the queued item still matches the captured snapshot. If the queue has
   advanced or been interrupted, the retry is dropped (logged at debug)
   instead of re-sending the wrong item.
5. After `transientRetryMaxAttempts` (default `3`) attempts, falls through
   to the existing `abortQueue` path.
6. `interruptSending` and `transitionToIdle` cancel any pending retry
   timer eagerly, so a fresh inbound or chat silence does not leave a
   stale retry primed against a queue that has moved on.

### Stall on SMS_LIMIT_REACHED

When the error is classified as `sms_limit`, the agent:

1. Reads any persisted stall via `LimitCounterStore.getSmsLimitStall`.
2. Computes `attempts = (existing?.attempts ?? 0) + 1`. If `attempts >
   smsLimitMaxAttempts` (default `24`), clears the persisted stall and
   falls through to `abortQueue` instead of scheduling another retry.
3. Persists the new `{ attempts, nextRetryAt, conversationKey }` via
   `setSmsLimitStall` (write-through — `/admin/limits` is live, and a
   fresh process can resume on boot via `recoverPendingRetries`).
4. Calls `SmsLimitStallScheduler.schedule(lineNumber, retry, intervalMs)`,
   which fires `runRetry(conversationKey, expected)` after `intervalMs`
   (default `3600000` — 1 hour). The same item-identity check as
   transient retry guards against firing on a stale queue.
5. On the next successful `DELIVERED`/`SENT` advance, `clearSmsLimitStall`
   wipes the persisted stall so a future stall starts a fresh counter.

### `GET /admin/limits`

Mounted **only** when `ADMIN_API_TOKEN` is set. Auth via either
`Authorization: Bearer <token>` or `x-admin-api-token: <token>` header.
Returns a JSON snapshot:

```json
{
  "snapshot": {
    "lineNumber": "+15552220000",
    "outbound": { "secondCount": 0, "hourCount": 12, "dayCount": 240 },
    "inboundContactsToday": 8,
    "followUpsToday": 1,
    "smsLimitStallAttempts": 0
  }
}
```

The `lineNumber` query parameter selects which line to snapshot; default
is `SENDBLUE_FROM_NUMBER`.

## Code files

| File | Role |
| --- | --- |
| `src/limits/store.ts` | `LimitCounterStore` interface + `InMemoryLimitCounterStore` |
| `src/limits/redis-store.ts` | `RedisLimitCounterStore` (production) |
| `src/limits/tracker.ts` | `createLimitTracker` orchestrator + threshold logging + `acquire_send_slot_delay_seconds` / `limit_threshold_crossings_total` metrics |
| `src/limits/retry.ts` | `transientRetryDelayMs`, `InMemorySmsLimitStallScheduler` |
| `src/conversation/agent.ts` | `handleSendError`, `maybeRetryFromStatus`, `scheduleTransientRetry`, `scheduleSmsLimitStall` (also emit `transient_retry_total` / `sms_limit_stall_total` metrics) |
| `src/http/admin.ts` | `mountAdminRoutes`, header-secret auth (now shared with `/metrics` and the introspection routes) |
| `src/http/auth.ts` | Shared `validateAdminToken` extracted for reuse across `/admin/*` and `/metrics` |
| `src/status/tracker.ts` | `classifyErrorCode` reused for status-callback classification (and the `error_category` label on `status_callback_total`) |

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `OUTBOUND_RATE_LIMIT_PER_SECOND` | `1` | Sendblue Agent plan documented |
| `OUTBOUND_RATE_LIMIT_PER_HOUR` | `2000` | Sendblue Agent plan documented |
| `OUTBOUND_RATE_LIMIT_PER_DAY` | `4000` | Sendblue Agent plan documented |
| `INBOUND_CONTACTS_PER_DAY_WARN_THRESHOLD` | `800` | Warn at 80% of 1k |
| `INBOUND_CONTACTS_PER_DAY_LIMIT` | `1000` | Sendblue Agent plan documented |
| `FOLLOW_UP_DAILY_WARN_THRESHOLD` | `160` | Warn at 80% of 200 |
| `FOLLOW_UP_DAILY_LIMIT` | `200` | Track-only; sends not gated |
| `REPLY_WINDOW_HOURS` | `24` | In-window vs follow-up classification |
| `TRANSIENT_RETRY_MAX_ATTEMPTS` | `3` | Per-message retry budget |
| `TRANSIENT_RETRY_BASE_MS` | `1000` | Backoff base — schedule is base × 4^(attempt-1) |
| `TRANSIENT_RETRY_MAX_MS` | `60000` | Cap on individual retry delay |
| `SMS_LIMIT_RETRY_INTERVAL_MS` | `3600000` | 1 hour |
| `SMS_LIMIT_MAX_ATTEMPTS` | `24` | 24 attempts × 1h = 24h bound |
| `ADMIN_API_TOKEN` | — | Unset = `/admin/limits` not mounted |
| `REDIS_URL` | — | Required for accurate multi-replica pacing |

## Known limitations

- **Multi-replica pacing without Redis overshoots 1/s** because each
  process has its own in-memory token bucket. Configure `REDIS_URL` —
  the Redis-backed pacer uses a Lua `EVAL` for atomic compare-and-set
  (verified by `tests/integration/limits-redis-store.test.ts`, opt in via
  `TEST_REDIS_URL=redis://...`; see `docs/TESTING.md`). 10 concurrent
  acquires on the same line correctly serialize to 0/1000/2000/.../9000ms.
- **Boot-time recovery is best-effort.** On `createApp()` startup the
  agent enumerates persisted SMS stalls and conversation records via
  Redis SCAN and re-arms timers with the remaining delay. Stranded
  stalls (no matching conversation in `'sending'` state) are cleared so
  `/admin/limits` doesn't report a phantom counter. Recovery runs
  non-blocking — a slow SCAN does not gate startup. With
  `REDIS_URL` unset, recovery is a no-op (in-memory state is gone).
  Two-process restart races schedule duplicate timers; the
  item-identity check inside `runRetry` drops the stale fire.
- **Counter validation is enforced at boot.** `loadConfig()` rejects
  configs where `*_WARN_THRESHOLD > *_LIMIT` for the inbound and
  follow-up pairs, and where `OUTBOUND_RATE_LIMIT_PER_HOUR >
  OUTBOUND_RATE_LIMIT_PER_DAY` or `TRANSIENT_RETRY_BASE_MS >
  TRANSIENT_RETRY_MAX_MS`. Misconfig fails fast instead of silently
  swallowing the warn-log emission.
- **Zero-TTL guards.** `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS`,
  `SMS_LIMIT_RETRY_INTERVAL_MS`, and `SMS_LIMIT_MAX_ATTEMPTS` must be
  `>= 1`; the loader rejects `0`. Defensive guards inside
  `claimContactUpsert` also short-circuit on non-positive TTL so a
  future config-loader regression cannot crash the inbound path.
- **SMS_LIMIT_REACHED reset timezone is undocumented.** The 1-hour retry
  loop is the safety net — it does not depend on knowing Sendblue's exact
  reset boundary. UTC is assumed for warn/error log thresholds.
- **The 200/day follow-up cap is track-only.** Sendblue does not return a
  distinct error code for follow-up overage on inbound; the warn/error
  logs help operators notice approaching the limit but the agent does not
  defer or drop sends.
- **Inline retry only handles `sendOutboundAction` paths** that throw a
  `SendblueApiError` with a transient classification. Reactions
  (`/api/send-reaction`), mark-read, and typing indicators retain their
  existing skip-on-error behavior — those calls are best-effort and
  iMessage-only, so a 429 there is unlikely.
- **Group sends are not paced for the follow-up classification** because
  group conversations don't have a meaningful 24h reply window per
  participant. Group outbound increments the rate counters but not the
  follow-up counter.
- **Admin route auth is shared-secret.** The header is compared via
  `crypto.timingSafeEqual`; the route is **not mounted at all** when
  `ADMIN_API_TOKEN` is unset (preventing accidental exposure in
  misconfigured deploys). For production, pair with HTTPS and IP
  allow-listing at the load balancer. The same token now gates
  `GET /metrics` and the rest of the introspection set
  (`/admin/conversations`, `/admin/status`, `/admin/queue`,
  `/admin/dedupe`); see `docs/features/operational-visibility.md`.
