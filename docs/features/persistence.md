# Persistence (Conversation Store)

## What it does

Persists three things across the lifecycle of a Sendblue conversation:

1. **Conversation records** — channel state, buffering state, outbound
   queue, identity cache, downgrade flag, group metadata.
2. **Inbound dedupe claims** — see `docs/features/inbound-dedupe.md`.
3. **Outbound-handle → conversation-key mappings** — so a Sendblue
   `status_callback` arriving with `message_handle` can be routed to the
   right conversation queue.

Two implementations of the `ConversationStore` interface ship: an
in-memory store for tests and local development, and a Redis store for
production. The in-memory store is **not safe for production** —
state is per-process and disappears on restart.

## How it works

The `ConversationStore` interface is small and synchronous in shape (all
methods return `Promise`s, but the in-memory path completes without
awaiting):

```ts
getConversation(key): Promise<ConversationRecord | undefined>
setConversation(record): Promise<void>
deleteConversation(key): Promise<void>
claimInboundHandle(messageHandle): Promise<boolean>  // dedupe (destructive — claims on success)
peekInboundHandle(messageHandle): Promise<{ present: boolean; ttlSeconds?: number }>  // non-destructive probe for /admin/dedupe
mapOutboundHandle(messageHandle, mapping): Promise<void>
getOutboundHandleMapping(messageHandle): Promise<OutboundHandleMapping | undefined>
deleteOutboundHandleMapping(messageHandle): Promise<void>
claimContactUpsert(lineNumber, phoneNumber, ttlSeconds): Promise<boolean>  // contact dedupe (no-op when ttlSeconds <= 0)
listConversationKeys(): AsyncIterable<string>  // boot-time replay scan for transient retries
```

The `LimitCounterStore` interface is parallel and adds:

```ts
getSmsLimitStall(lineNumber): Promise<SmsLimitStall | undefined>
setSmsLimitStall(lineNumber, { attempts, nextRetryAt, conversationKey }): Promise<void>
clearSmsLimitStall(lineNumber): Promise<void>
listSmsLimitStalls(): Promise<SmsLimitStallEntry[]>  // boot-time replay enumeration
```

`SmsLimitStall` payload includes `conversationKey` so a fresh process at
boot can replay the stall against the right outbound queue. The Redis
implementation rejects legacy stall entries (written before this field
existed) by treating them as expired during deserialization.

### Conversation record keys

Direct: `direct:{sendblueLine}:{phoneNumber}`
Group:  `group:{sendblueLine}:{groupId}`

**One record across iMessage / RCS / SMS / downgrade.** Per AGENTS.md, do
not split a conversation by service. Channel changes (downgrade,
RCS-fallback) update fields on the same record; they do not create a new
one.

The record carries an optional `traceId` captured at the inbound webhook
entry. Status callbacks for outbound messages from this conversation
recover that traceId via the outbound handle mapping (which also stores
it) and chain it into log lines as `conversationTraceId` so a single
iMessage round trip is correlated end-to-end without external tracing
infrastructure. See `docs/features/operational-visibility.md`.

### Redis key formats

| Logical key | Redis key | TTL |
| --- | --- | --- |
| Conversation record | `sendblue-ai-agent:conversation:{key}` | `CONVERSATION_TTL_SECONDS` |
| Inbound dedupe claim | `sendblue-ai-agent:dedupe:inbound:{messageHandle}` | `DEDUPE_TTL_SECONDS` |
| Outbound-handle mapping | `sendblue-ai-agent:outbound:{messageHandle}` | `CONVERSATION_TTL_SECONDS` |
| Contact upsert dedupe | `sendblue-ai-agent:contact-upserted:{line}:{phone}` | `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS` |
| Outbound rate buckets | `sendblue-ai-agent:limits:outbound:{second\|hour\|day}:{line}:{bucket}` | 2s / 1h / 24h |
| Distinct inbound set | `sendblue-ai-agent:limits:inbound:distinct:{line}:{utc-day}` | 24h |
| Follow-up day counter | `sendblue-ai-agent:limits:followup:day:{line}:{utc-day}` | 24h |
| Last inbound timestamp | `sendblue-ai-agent:limits:last-inbound:{line}:{phone}` | 24h |
| Pacing slot (Lua-managed) | `sendblue-ai-agent:limits:slot:{line}` | 4 × interval (≥1s) |
| SMS-limit stall metadata | `sendblue-ai-agent:limits:sms-stall:{line}` | 24h |

All values are `JSON.stringify`'d on write and `JSON.parse`'d on read.
The Redis client is `ioredis` with `maxRetriesPerRequest: null` so
in-flight commands wait through transient disconnects rather than
failing the request.

### Outbound-handle map lifecycle

When the agent sends an outbound message via Sendblue, the returned
`message_handle` is mapped back to the conversation key (so the eventual
`status_callback` can reach the right queue). The mapping is deleted in
four places to avoid stale Redis keys:

- `interruptSending` — the in-flight handle is abandoned because a fresh
  inbound arrived.
- `abortQueue` — `ERROR`/`DECLINED` terminated the queue.
- `advanceQueue` — the queue advanced past this handle (the common case).
- `transitionToIdle` — defensive cleanup if a handle is somehow still
  attached when transitioning.

Without explicit cleanup, mappings would stay in Redis until
`CONVERSATION_TTL_SECONDS` expired them — benign but cluttery.

## Code files

| File | Role |
| --- | --- |
| `src/conversation/store.ts` | `ConversationStore` interface + `InMemoryConversationStore` (incl. `claimContactUpsert`, `listConversationKeys`) |
| `src/conversation/redis-store.ts` | `RedisConversationStore` (key formats, TTLs, ioredis wiring) |
| `src/conversation/types.ts` | `ConversationRecord` and `OutboundHandleMapping` shapes |
| `src/conversation/agent.ts` | Sole consumer; also owns `recoverPendingRetries` for boot replay |
| `src/limits/store.ts` | `LimitCounterStore` interface + `InMemoryLimitCounterStore` (incl. `listSmsLimitStalls` and the `SmsLimitStall` payload) |
| `src/limits/redis-store.ts` | `RedisLimitCounterStore` (Lua `EVAL` for the pacing slot AND for `INCR`+`EXPIRE`-on-first to keep counters atomic under eviction; SCAN-based `listSmsLimitStalls`) |
| `src/http/app.ts` | Selects in-memory vs Redis stores based on `REDIS_URL`; calls `agent.recoverPendingRetries()` non-blocking after wiring |

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `REDIS_URL` | — | Selects Redis variants of `ConversationStore` and `LimitCounterStore`; without it both fall back to in-memory. |
| `CONVERSATION_TTL_SECONDS` | `86400` | Conversation records and outbound-handle mappings expire together. |
| `DEDUPE_TTL_SECONDS` | `86400` | Inbound dedupe claims expire independently — see `docs/features/inbound-dedupe.md`. |
| `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS` | `2592000` | Per-(line, phone) dedupe for the contact upsert hook. Must be `>= 1` (loader rejects `0`); `claimContactUpsert` returns `false` defensively when the runtime ttl is non-positive. |

## Known limitations

- **In-memory store loses state on restart.** Tests/local only.
- The store interface intentionally has no transaction primitives. Each
  operation is single-key, and the agent layer is structured to need at
  most one mutation per side-effect. If you add multi-key invariants in
  the future, model them as Lua scripts on the Redis side.
- TTLs are absolute, not sliding. A long-idle conversation that suddenly
  receives a message will reset the TTL on the next write, but no read
  refreshes the TTL. Acceptable; documented so future readers don't add
  surprising behavior.
- Conversation records are stored as a single JSON blob. Large
  `outboundQueue` / `lateArrivals` arrays therefore round-trip in full
  on every persist. The agent prunes these aggressively at idle
  transitions.
- The Redis client uses `maxRetriesPerRequest: null` to tolerate brief
  disconnects. Long Redis outages will queue commands and surface as
  slow webhook handling rather than fast failures.
- `bumpCounter` (the per-line `INCR`+`EXPIRE` for the time-window
  buckets in `RedisLimitCounterStore`) runs as a single Lua `EVAL`. The
  earlier two-call sequence (`INCR` then conditional `EXPIRE`) had a
  failure mode where Redis eviction between calls could leave a counter
  immortal; the Lua path closes that window. Sendblue traffic is
  unlikely to trigger LRU eviction in practice, but the atomic version
  removes the worry.
- **Boot-time recovery via SCAN.** `recoverPendingRetries` enumerates
  `sendblue-ai-agent:limits:sms-stall:*` and
  `sendblue-ai-agent:conversation:*` to re-arm timers for stalls and
  transient retries persisted by a previous process. SCAN is
  cursor-based and non-blocking on the Redis side, but for very large
  conversation keyspaces (>100k records) the boot scan can be slow.
  Mitigation: recovery runs `void`-ed from `createApp()` so it never
  gates startup; for that scale, consider a follow-up that adds a
  dedicated `sendblue-ai-agent:retries:pending` sorted-set index keyed
  by `nextRetryAt` epoch.
