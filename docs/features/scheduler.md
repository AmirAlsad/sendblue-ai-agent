# Buffer Scheduler

## What it does

Schedules a per-conversation buffer-flush callback after a delay, and
cancels it when a fresh inbound message extends the buffer window. Used
by the conversation agent to coalesce rapid-fire inbound bursts (see
`docs/features/message-buffering.md`) into a single chat-endpoint call.

## How it works

The `BufferScheduler` interface has three methods:

- `schedule(conversationKey, delayMs)` — register a fresh delayed
  callback for the conversation. Replaces any existing scheduled callback
  for the same key (no need to cancel manually before scheduling).
- `cancel(conversationKey)` — remove a pending callback (e.g. when the
  conversation has just been flushed by another path).
- `setHandler(handler)` — wires the callback the scheduler invokes when
  a delay elapses. The agent registers this once at boot.

Two implementations satisfy the contract:

- **`InMemoryBufferScheduler` (test/local):** wraps `setTimeout`. Keys
  are stored in a `Map<conversationKey, NodeJS.Timeout>`. `delayMs <= 0`
  invokes the handler synchronously instead of scheduling.
- **`BullMqBufferScheduler` (production):** uses BullMQ delayed jobs on
  the queue named `BUFFER_QUEUE_NAME` (default
  `sendblue-buffer-timers`). Job ID is `buffer:{conversationKey}` so a
  re-`schedule` for the same conversation deterministically replaces the
  prior job. A single `Worker` consumes the queue with `concurrency: 1`
  to preserve per-conversation ordering. `attempts: 1` — buffer-flush
  failures are logged but not retried (the conversation state is
  authoritative; a retry on the same key would re-flush stale state).

Selection happens in `createApp` based on whether `REDIS_URL` is set.

## Code files

| File | Role |
| --- | --- |
| `src/conversation/scheduler.ts` | Both implementations of `BufferScheduler` |
| `src/conversation/agent.ts` | Calls `schedule`/`cancel` from the buffering paths |
| `src/http/app.ts` | Selects which scheduler to construct based on `REDIS_URL` |

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `REDIS_URL` | — | Selects `BullMqBufferScheduler`; without it the in-memory scheduler is used. |
| `BUFFER_QUEUE_NAME` | `sendblue-buffer-timers` | BullMQ queue name. Set to a stable value per environment to avoid cross-environment job collisions. |

## Known limitations

- In-memory timers do not survive process restart. A pending buffer flush
  during a restart is lost; the next inbound on that conversation will
  re-buffer from scratch. Acceptable for tests and local smoke runs;
  unacceptable for production.
- The BullMQ worker uses `concurrency: 1` deliberately. If you scale
  horizontally, every replica should share the same Redis instance so
  BullMQ's delivery semantics keep per-conversation ordering. Multiple
  workers across processes are fine; multiple workers competing for the
  same job are not — BullMQ handles that, but only when they share Redis.
- BullMQ's `removeOnComplete: true` and `removeOnFail: 100` keep the
  Redis queue bounded. The 100 failed-job retention is intentional for
  operability; tune if your environment has noisier failures.
- Worker connections are separate `Redis` instances from the queue
  connection (BullMQ requirement). Both must be on `REDIS_URL`.
