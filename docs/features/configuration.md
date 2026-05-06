# Configuration and Tunables

## What it does

Documents runtime configuration for the Sendblue agent, including webhook
security, Sendblue delivery, chat endpoint calls, Redis/BullMQ-backed
conversation intelligence, identity lookup, and typing indicators.

## How it works

Configuration is loaded from environment variables by `loadConfig()`. Required
values are validated at startup, URL values used as bases are normalized by
removing trailing slashes, and optional numeric/boolean values fall back to
defaults when unset.

When `REDIS_URL` is configured, the app uses Redis for conversation records,
inbound dedupe keys, outbound handle mappings, and BullMQ buffer timers. When it
is absent, the app uses in-memory state and timers for local development and
hardware-free tests. Redis/BullMQ is the production path because in-memory state
does not survive process restarts and cannot coordinate multiple instances.

## Code files

| File | Role |
| --- | --- |
| `src/config/env.ts` | Environment parsing and defaults |
| `src/http/app.ts` | Chooses Redis/BullMQ or in-memory dependencies |
| `src/http/security.ts` | Optional webhook secret validation |
| `src/sendblue/client.ts` | Sendblue API base URL, credentials, outbound message and typing calls |
| `src/chat/client.ts` | Chat endpoint URL and request timeout |
| `src/conversation/redis-store.ts` | Redis key storage and TTLs |
| `src/conversation/scheduler.ts` | BullMQ queue name and timer behavior |
| `src/identity/resolver.ts` | Optional HTTP identity resolver |

## Configuration

Required for the agent:

- `PUBLIC_BASE_URL` - public URL for Sendblue status callbacks; used to build `/webhook/status`.
- `CHAT_ENDPOINT_URL` - HTTP endpoint that generates replies.
- `SENDBLUE_API_KEY_ID` - Sendblue API key ID. Sent on every Sendblue API
  request as the `sb-api-key-id` header. The official Sendblue TypeScript SDK
  documents `SENDBLUE_API_API_KEY` for the same value; this package keeps
  `SENDBLUE_API_KEY_ID` because it mirrors the documented HTTP header name and
  predates the SDK convention.
- `SENDBLUE_API_SECRET_KEY` - Sendblue API secret. Sent as `sb-api-secret-key`.
  The Sendblue SDK documents `SENDBLUE_API_API_SECRET` for the same value.
- `SENDBLUE_FROM_NUMBER` - dedicated Sendblue line used for outbound messages
  and direct conversation keys. Validated as E.164 at `loadConfig` startup
  (leading `+` then 10–15 digits). Invalid values like `++15551234567` (a
  common copy-paste typo) throw immediately with a clear error rather than
  silently 400ing the first Sendblue API call with `"You must specify a valid
  from_number"`.

Optional server and API values:

- `PORT` - Express port, default `3000`.
- `SENDBLUE_API_BASE_URL` - Sendblue v1 API origin, default `https://api.sendblue.co`.
- `SENDBLUE_API_V2_BASE_URL` - Sendblue v2 API origin (used for v2 endpoints
  such as `mark-read`), default `https://api.sendblue.com`.
- `CHAT_ENDPOINT_TIMEOUT_MS` - chat endpoint timeout, default `10000`.

Optional process control (consumed in `src/index.ts`, not by `loadConfig`):

- `AGENT_AUTOSTART` - when `0`, the app does not auto-start on import; useful
  for embedding `createApp` in a custom entry point.
- `NODE_ENV` - when `test`, autostart is also skipped so test imports do not
  bind a port.

Optional webhook security:

- `SENDBLUE_WEBHOOK_SECRET` - expected webhook secret. When unset, webhook secret validation is disabled.
- `SENDBLUE_WEBHOOK_SECRET_HEADER` - custom header name, default `sb-signing-secret`.

Optional Redis/conversation storage:

- `REDIS_URL` - enables Redis conversation storage and BullMQ timers.
- `CONVERSATION_TTL_SECONDS` - Redis TTL for conversation records and outbound handle mappings, default `86400`.
- `DEDUPE_TTL_SECONDS` - TTL for inbound `message_handle` dedupe keys, default `86400`.

Optional buffering:

- `BUFFER_BASE_TIMEOUT_MS` - initial debounce delay, default `2000`.
- `BUFFER_GROWTH_FACTOR` - multiplier as a burst grows, default `1.25`.
- `BUFFER_MAX_TIMEOUT_MS` - cap for the calculated delay, default `8000`.
- `BUFFER_NOISE_MAX_DEVIATION` - random jitter as a percentage of the capped delay, default `0.3`.
- `MAX_REPROCESS_ATTEMPTS` - number of late-arrival reprocess passes, default `2`.
- `CANCELLED_MESSAGE_MAX_LENGTH` - truncation length for interrupted outbound text, default `150`.
- `BUFFER_QUEUE_NAME` - BullMQ queue name, default `sendblue-buffer-timers`.

Optional ordered delivery:

- `OUTBOUND_DELIVERY_TIMEOUT_MS` - maximum wait for the current outbound status callback before advancing, default `30000`.

Optional identity and typing:

- `USER_LOOKUP_URL` - HTTP resolver used to enrich chat requests with `{ userId, data }`.
- `IDENTITY_RESOLVER_TIMEOUT_MS` - per-request timeout for `USER_LOOKUP_URL`,
  default `5000`. Set to `0` to disable. The agent fails open with
  `identity: null` on any resolver error.
- `OUTBOUND_TYPING_INDICATORS_ENABLED` - sends best-effort Sendblue typing indicators for direct iMessage conversations, default `true`.
- `INBOUND_TYPING_STATE_ENABLED` - stores inbound typing webhooks for inclusion
  in the next chat request, default `true`. This only has live effect when the
  Sendblue account/line can register and receive the documented
  `typing_indicator` webhook type.

Optional rich actions:

- `CHAT_RESPONSE_PARSE_TAGS` - parses supported XML-style tags from legacy string responses into rich actions, default `true`.
- `CHAT_RESPONSE_MESSAGE_TAG` - message tag name, default `message`.
- `CHAT_RESPONSE_NO_RESPONSE_TAG` - silence tag name, default `no_response`.
- `CHAT_RESPONSE_REACTION_TAG` - reaction tag name, default `reaction`.
- `CHAT_RESPONSE_REPLY_TAG` - reply tag name, default `reply`.
- `READ_RECEIPTS_ENABLED` - allows best-effort direct iMessage/RCS
  `POST /api/mark-read` calls after Sendblue account support is confirmed for
  the deployed line, default `false`. Status callbacks do not include `READ`.
- `READ_RECEIPT_DEBOUNCE_MS` - read receipt debounce before chat processing, default `250`.
- `TYPING_REFRESH_INTERVAL_MS` - refresh interval for repeated outbound typing indicators while a long-running response is in progress, default `5000`.
- `TYPING_REFRESH_MAX_MS` - maximum typing refresh duration, default `120000`.

Optional group routing:

- `AGENT_DISPLAY_NAME` - name that marks a group message as addressed to the agent, default `sb-agent`.
- `VALID_USER_REQUIRED` - silently acknowledges null or unauthorized identities, including the invoking participant in groups, default `false`.

Boolean values are enabled by `1`, `true`, `yes`, or `on` case-insensitively.
Other values are treated as false when the variable is present.

## Known limitations

- `.env.example` currently focuses on base runtime and E2E values; keep it,
  README, and this document in sync as tunables are promoted there.
- In-memory state is suitable for tests and local experiments only.
- Webhook secret validation is shared across receive, status, typing, and
  operational webhook routes. The header name remains configurable because
  Sendblue's secret-header behavior should be confirmed from real captures
  before enforcing production policy.
- Rich action env vars should remain opt-in until real-device E2E verifies
  Sendblue behavior for the deployed line, especially read receipts, reactions,
  replies, and group routing.
