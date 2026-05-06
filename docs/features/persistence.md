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
claimInboundHandle(messageHandle): Promise<boolean>  // dedupe
mapOutboundHandle(messageHandle, mapping): Promise<void>
getOutboundHandleMapping(messageHandle): Promise<OutboundHandleMapping | undefined>
deleteOutboundHandleMapping(messageHandle): Promise<void>
```

### Conversation record keys

Direct: `direct:{sendblueLine}:{phoneNumber}`
Group:  `group:{sendblueLine}:{groupId}`

**One record across iMessage / RCS / SMS / downgrade.** Per AGENTS.md, do
not split a conversation by service. Channel changes (downgrade,
RCS-fallback) update fields on the same record; they do not create a new
one.

### Redis key formats

| Logical key | Redis key | TTL |
| --- | --- | --- |
| Conversation record | `sendblue-ai-agent:conversation:{key}` | `CONVERSATION_TTL_SECONDS` |
| Inbound dedupe claim | `sendblue-ai-agent:dedupe:inbound:{messageHandle}` | `DEDUPE_TTL_SECONDS` |
| Outbound-handle mapping | `sendblue-ai-agent:outbound:{messageHandle}` | `CONVERSATION_TTL_SECONDS` |

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
| `src/conversation/store.ts` | `ConversationStore` interface + `InMemoryConversationStore` |
| `src/conversation/redis-store.ts` | `RedisConversationStore` (key formats, TTLs, ioredis wiring) |
| `src/conversation/types.ts` | `ConversationRecord` and `OutboundHandleMapping` shapes |
| `src/conversation/agent.ts` | Sole consumer; never reads Redis directly |
| `src/http/app.ts` | Selects which store to construct based on `REDIS_URL` |

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `REDIS_URL` | — | Selects `RedisConversationStore`; without it `InMemoryConversationStore` is used. |
| `CONVERSATION_TTL_SECONDS` | `86400` | Conversation records and outbound-handle mappings expire together. |
| `DEDUPE_TTL_SECONDS` | `86400` | Dedupe claims expire independently — see `docs/features/inbound-dedupe.md`. |

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
