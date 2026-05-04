# Message Buffering and Interruptions

## What it does

Buffers inbound messages per user to aggregate multi-message bursts, handles late arrivals, and supports interruption handling while outbound messages are being delivered.

## How it works

Conversation state lives in Redis. When a user is idle, the first inbound message transitions the state to `buffering` and schedules a BullMQ timer. Additional messages reset the timer with exponential backoff and noise. When the timer fires, messages are aggregated and sent to the chat endpoint. If late arrivals come in during processing, the state reprocesses up to a configured limit. If the user interrupts while outbound messages are being sent, remaining messages are cancelled and the interruption context is stored for the next turn.

The aggregator uses a `\n---\n` delimiter when joining buffered text. The first buffer item with a `repliedToSid` (WhatsApp swipe-reply) wins for reply-context attribution. Cancelled messages from an interruption are truncated to `CANCELLED_MESSAGE_MAX_LENGTH` and forwarded to the chat endpoint as `[INTERRUPTED: ...]` context on the next turn.

## Code files

| File | Role |
| --- | --- |
| `src/state/conversation-state.js` | Redis state machine, transitions, buffer timing |
| `src/timers/buffer-timer-manager.js` | Schedule/cancel BullMQ buffer timers |
| `src/timers/buffer-timer-worker.js` | Timer worker that calls the chat endpoint |
| `src/aggregation/context-assembler.js` | Aggregation and interruption context formatting |
| `src/aggregation/interruption-handler.js` | Interruption flow coordination |

## Configuration

- `BUFFER_BASE_TIMEOUT_MS`
- `BUFFER_GROWTH_FACTOR`
- `BUFFER_MAX_TIMEOUT_MS`
- `BUFFER_NOISE_MAX_DEVIATION`
- `MAX_REPROCESS_ATTEMPTS`
- `CANCELLED_MESSAGE_MAX_LENGTH`
- `BUFFER_QUEUE_NAME`
- `REDIS_URL`

## Known limitations

- Timers are BullMQ-based; if Redis is unavailable, buffering falls back to immediate handling.
- Late arrivals beyond the reprocess limit are deferred to the next turn.
