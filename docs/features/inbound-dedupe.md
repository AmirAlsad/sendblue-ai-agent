# Inbound Dedupe

## What it does

Drops duplicate inbound Sendblue webhooks by `message_handle` so the
conversation agent processes each delivery exactly once, even though
Sendblue retries a webhook up to 3 times on `5xx` responses (45-second
timeout per attempt per
[Sendblue webhooks docs](https://docs.sendblue.com/getting-started/webhooks/)).

This is load-bearing: the receive route returns `502` on synchronous
chat-endpoint failure (which Sendblue retries), and dedupe is what stops
those retries from invoking the chat endpoint repeatedly when the original
attempt already succeeded.

## How it works

`ConversationStore.claimInboundHandle(messageHandle)` is a one-shot atomic
claim. The first caller for a given handle gets `true`; every subsequent
caller (within `DEDUPE_TTL_SECONDS`) gets `false`. The conversation agent
calls this at the start of every receive (`src/conversation/agent.ts:83`)
and short-circuits when the claim fails.

Two implementations satisfy the contract:

- **Redis (production):** `SET <key> 1 EX <ttl> NX`. `NX` makes the claim
  atomic across processes — Redis-side concurrency is the source of
  exactly-once semantics.
- **In-memory (test/local):** A `Map<messageHandle, expiresAtMs>` with
  expiry checked on read. The implementation is functionally serial within
  a Node process because there is no `await` between the read and write,
  but it provides no cross-process guarantee.

Redis key format: `sendblue-ai-agent:dedupe:inbound:{messageHandle}`

The TTL bounds memory/Redis usage and matches Sendblue's expected retry
window. Default is one day, which comfortably covers the documented
3-retry × 45-second budget plus operational delays.

## Code files

| File | Role |
| --- | --- |
| `src/conversation/store.ts` | `ConversationStore.claimInboundHandle` interface and in-memory implementation |
| `src/conversation/redis-store.ts` | `RedisConversationStore.claimInboundHandle` (`SET NX EX`) and key format |
| `src/conversation/agent.ts:83` | Caller — guards `handleReceive` |

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `DEDUPE_TTL_SECONDS` | `86400` | TTL for the dedupe record. Must be ≥ Sendblue's worst-case retry window (3 × 45s plus tolerance). |
| `REDIS_URL` | — | Selects the Redis store; without it the in-memory store is used. |

## Known limitations

- In-memory dedupe is per-process and does not survive restart. If the
  process crashes between accepting a webhook and persisting conversation
  state, a Sendblue retry will be processed as new. Use Redis in production.
- Outbound `message_handle` (returned by Sendblue on send) is mapped
  separately via `mapOutboundHandle` / `deleteOutboundHandleMapping` for
  status-callback routing — see `docs/features/persistence.md`. The two
  spaces are distinct: an inbound and an outbound message can technically
  share a handle without colliding.
- The in-memory expiry check is on read only — there is no background
  sweeper. For long-running test sessions this is bounded by the TTL but
  not actively reclaimed.
