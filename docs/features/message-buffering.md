# Message Buffering and Interruptions

## What it does

Buffers rapid direct-message bursts per conversation, aggregates them into one
chat endpoint request, handles messages that arrive while the chat endpoint is
processing, and interrupts unsent outbound replies when the user sends a new
message during delivery.

## How it works

Conversation state lives behind the `ConversationStore` interface. In
production, `RedisConversationStore` stores JSON records with
`CONVERSATION_TTL_SECONDS`; locally and in tests, `InMemoryConversationStore`
provides the same behavior without Redis durability.

The state machine uses four states:

- `idle` - no active buffered turn or outbound queue.
- `buffering` - inbound messages are collecting behind a debounce timer.
- `processing` - the buffer is being sent to the chat endpoint.
- `sending` - outbound messages are being delivered one at a time.

When the first direct inbound arrives in `idle`, the conversation transitions to
`buffering` and schedules a timer. Additional inbounds during `buffering` append
to `inboundBuffer` and reset the timer with an exponential delay:

```text
BUFFER_BASE_TIMEOUT_MS * BUFFER_GROWTH_FACTOR ^ (messageCount - 1)
```

The delay is capped by `BUFFER_MAX_TIMEOUT_MS` and can include bounded jitter
from `BUFFER_NOISE_MAX_DEVIATION`. Redis deployments schedule the timer through
BullMQ. In-memory deployments use `setTimeout`.

When the timer fires, the buffer moves to `processing`. The chat request keeps a
top-level backward-compatible `message` field by joining buffered text with:

```text
\n---\n
```

It also sends structured `messages[]` with per-message Sendblue metadata.

If a new inbound arrives during `processing`, it is stored in `lateArrivals`.
After the current chat call returns, the agent re-enters `buffering`, merges
late arrivals into the next buffer, and retries processing up to
`MAX_REPROCESS_ATTEMPTS`. Within that limit, this prevents stale replies from
being sent when a user adds context during response generation.

If a new inbound arrives during `sending`, unsent queued replies are cancelled,
their content is truncated to `CANCELLED_MESSAGE_MAX_LENGTH`, and the new
inbound starts a fresh buffer. The current outbound message cannot be recalled
after it has already been sent to Sendblue, but remaining queued messages are
not sent.

## Code files

| File | Role |
| --- | --- |
| `src/conversation/agent.ts` | State transitions, late arrivals, interruptions |
| `src/conversation/buffering.ts` | Buffer delay calculation and truncation helper |
| `src/conversation/chat-request.ts` | Aggregation and chat request assembly |
| `src/conversation/scheduler.ts` | BullMQ and in-memory buffer timers |
| `src/conversation/store.ts` | In-memory conversation/dedupe/outbound mapping store |
| `src/conversation/redis-store.ts` | Redis-backed store |
| `src/conversation/types.ts` | Conversation record and direct-key types |

## Configuration

- `REDIS_URL`
- `CONVERSATION_TTL_SECONDS`
- `DEDUPE_TTL_SECONDS`
- `BUFFER_BASE_TIMEOUT_MS`
- `BUFFER_GROWTH_FACTOR`
- `BUFFER_MAX_TIMEOUT_MS`
- `BUFFER_NOISE_MAX_DEVIATION`
- `MAX_REPROCESS_ATTEMPTS`
- `CANCELLED_MESSAGE_MAX_LENGTH`
- `BUFFER_QUEUE_NAME`

## Known limitations

- Cancelled outbound messages are currently stored in state but are not yet
  forwarded to the chat endpoint as explicit interruption context.
- Late arrivals beyond `MAX_REPROCESS_ATTEMPTS` are currently discarded when
  the queued response begins sending; the implementation does not yet model a
  separate deferred turn queue.
- BullMQ timer concurrency is currently fixed in code.
- In-memory timers and stores cannot coordinate horizontally scaled instances.
