# Broadcast Distribution

## What it does

Distributes a single broadcast message to all active users by enqueuing per-user triggers at a controlled rate.

## How it works

`POST /triggers` with `userId: 'ALL'` initiates a broadcast. The broadcast manager walks the user adapter's `listActiveUsers({limit, cursor})` paginated, enqueues a BullMQ job per user, and rate-limits enqueueing at `BROADCAST_RATE_LIMIT` jobs/sec. Each job becomes a per-user trigger that flows through the normal trigger pipeline (channel resolution, gate, typing indicator, chat endpoint call, ordered delivery).

The user adapter's `listActiveUsers` is required for broadcasts. If your adapter doesn't implement it (or your `USER_LOOKUP_URL` doesn't handle `resolveBy: 'listActive'`), broadcasts complete with zero users.

## Code files

| File | Role |
| --- | --- |
| `src/triggers/broadcast-manager.js` | Broadcast queue + worker + per-user fan-out |
| `src/adapters/user-adapter.js` | `listActiveUsers` resolution |
| `src/triggers/trigger-queue.js` | Per-user trigger enqueueing |

## Configuration

- `BROADCAST_QUEUE_NAME`
- `BROADCAST_RATE_LIMIT` — default 3 jobs/sec
- `REDIS_URL`
- `USER_LOOKUP_URL` (or `./adapters/user.js`) — must implement `listActiveUsers`

## Known limitations

- Broadcasts cap at 10,000 users per execution by default (see `MAX_USERS` constant in `broadcast-manager.js`).
- Rate limits are global; large broadcasts may take significant time.
- Broadcasts inherit the eligibility gate, so ineligible users are silently dead-lettered (no Twilio send).
