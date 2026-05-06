# Outbound Sendblue Client

## What it does

`HttpSendblueClient` (`src/sendblue/client.ts`) is the package's only path
to Sendblue's outbound HTTP API. It covers the documented endpoints the
conversation agent orchestrates today:

| Method                  | Endpoint                              | Base URL                                     |
| ----------------------- | ------------------------------------- | -------------------------------------------- |
| `sendMessage`           | `POST /api/send-message`              | `sendblueApiBaseUrl` (`api.sendblue.co`)     |
| `sendGroupMessage`      | `POST /api/send-group-message`        | `sendblueApiV2BaseUrl` (`api.sendblue.com`)  |
| `sendReaction`          | `POST /api/send-reaction`             | `sendblueApiV2BaseUrl`                       |
| `markRead`              | `POST /api/mark-read`                 | `sendblueApiV2BaseUrl`                       |
| `sendTypingIndicator`   | `POST /api/send-typing-indicator`     | `sendblueApiV2BaseUrl`                       |

The client deliberately does **not** wrap the official `@sendblue/api`
TypeScript SDK. The conversation agent's ordered-delivery and
status-tracking contract relies on attaching a *per-message*
`status_callback` to every `/api/send-message` call. Owning the request
shape avoids surprising SDK upgrades and lets us preserve other
load-bearing rules (forced `from_number`, omitting empty optional
fields, structured error reporting via `SendblueApiError`).

Endpoints exposed by the official SDK but intentionally out of scope:

- `client.messages.getStatus` (`GET /api/status`)
- `client.messages.retrieve` / `list` (`GET /api/v2/messages`,
  `GET /api/v2/messages/:id`, `DELETE /api/message/:handle`)
- `client.lookups.lookupNumber` (`GET /api/evaluate-service`)
- `client.groups.modify` (`POST /api/modify-group`)
- `client.sendCarousel.send` (`POST /api/send-carousel`)
- `client.mediaObjects.upload` (`POST /api/upload-media-object`)
- `client.contacts.*` (`/api/v2/contacts/...`)
- `client.webhooks.*` (`/api/account/webhooks`)
- `client.lines.callForwarding.*`
- `client.v2.totp.*`

If we add features that need any of these (e.g. proactive
`evaluate-service` lookups before sending iMessage-only effects, or
group participant management for v0.4), they should be implemented as
new methods on `HttpSendblueClient`.

The official SDK does **not** currently expose `send-reaction` or
`mark-read` even though the docs document them. This package owns those
endpoints because the rich-action contract (`v0.3`) needs them.

## How it works

### Authentication

All requests send the documented header pair:

```
sb-api-key-id: ${SENDBLUE_API_KEY_ID}
sb-api-secret-key: ${SENDBLUE_API_SECRET_KEY}
content-type: application/json
```

### Base URL split

Sendblue documents two distinct hosts:

- `https://api.sendblue.co` — `/api/send-message` reference.
- `https://api.sendblue.com` — API v2 reference page (group send,
  reactions, mark-read, typing indicator, carousel, contacts, webhooks).

The client honors the split via two config values
(`sendblueApiBaseUrl`, `sendblueApiV2BaseUrl`) so deployments can point
at either host (or a proxy) per endpoint family.

### `status_callback` semantics

`POST /api/send-message` documents `status_callback` as an *optional*
field, but this package treats it as required:

- `sendMessage` throws synchronously if `statusCallback` is empty.
- The conversation agent constructs the URL as
  `${publicBaseUrl}/webhook/status` for every send.
- There is no global default callback configured against the Sendblue
  account — every send carries its own URL so per-message status
  tracking works regardless of account-level settings.

`sendGroupMessage` accepts `statusCallback` as optional, since group
sends are not always tracked through the same ordered-delivery path.

### Optional fields

Optional fields (`media_url`, `send_style`, `seat_id`, `part_index`, group
`status_callback`) are forwarded only when set to a non-empty value.
`undefined`, `null`, and empty strings are stripped before the body is
serialized so Sendblue never sees explicit `null` values.

`seat_id` on `sendMessage` is the documented Sendblue field for multi-seat
attribution (UUID or Firebase Auth subject). Set
`SendblueOutboundMessage.seatId` to forward it; omit for the account default.

### Error handling

Any non-2xx response is mapped to a `SendblueApiError` (subclasses
`Error`):

```ts
import { SendblueApiError } from 'sendblue-ai-agent';

try {
  await client.sendMessage(...);
} catch (error) {
  if (error instanceof SendblueApiError) {
    error.operation;     // "send-message" | "send-reaction" | ...
    error.httpStatus;    // 400, 429, 502, ...
    error.errorCode;     // "4000" | "5509" | "SMS_LIMIT_REACHED" | ...
    error.serverMessage; // body.message ?? body.error_message
    error.responseBody;  // decoded JSON body, or null on parse failure
  }
}
```

The `errorCode` field aligns with `classifyErrorCode` in
`src/status/tracker.ts`, so the same value can drive the status-side
classification (`validation`, `rate_limit`, `blacklist`, `server`,
`send_failed`, `status_unresolved`, `sms_limit`, `unknown`).

The package does not implement automatic retry/backoff — Sendblue
already retries inbound webhook delivery on its side, and outbound
retries are an agent-level decision. The conversation agent currently
logs and skips on outbound failure rather than retrying.

### iMessage-only feature gating

Reactions, mark-read, typing indicators, and send effects are
iMessage-only on Sendblue's side. The client sends the documented
request as-is; the **conversation agent** owns suppression for SMS or
downgraded conversations because it has access to per-conversation
channel and `was_downgraded` state. The client returns whatever
Sendblue responds with, including `400` errors when the channel does
not support the feature.

## Code files

| File                                  | Role                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| `src/sendblue/client.ts`              | Public `SendblueClient` interface, `HttpSendblueClient`, `SendblueApiError` |
| `src/sendblue/types.ts`               | Outbound request/response shapes                            |
| `src/conversation/agent.ts`           | Calls into the client; owns iMessage-only suppression       |
| `src/status/tracker.ts`               | `classifyErrorCode` consumes the same `errorCode` strings   |
| `tests/unit/sendblue-client.test.ts`  | Unit coverage for every endpoint, error path, and base URL  |

## Configuration

| Env var                       | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `SENDBLUE_API_KEY_ID`         | `sb-api-key-id` header                                   |
| `SENDBLUE_API_SECRET_KEY`     | `sb-api-secret-key` header                               |
| `SENDBLUE_API_BASE_URL`       | v1 host for `send-message` (default `api.sendblue.co`)   |
| `SENDBLUE_API_V2_BASE_URL`    | v2 host for richer endpoints (default `api.sendblue.com`) |
| `SENDBLUE_FROM_NUMBER`        | Always sent as `from_number` on every request            |
| `PUBLIC_BASE_URL`             | Used by the agent to build per-message `status_callback` |

## Known limitations

- Reply intent is preserved in the chat contract but currently lands as
  a normal `send-message` — Sendblue's direct send has no documented
  reply-target field.
- No retry/backoff. Transient categories (`5509`, `5003`,
  `SMS_LIMIT_REACHED`) surface as `SendblueApiError`; the agent's
  policy is to log + skip the action.
- Group-send `status_callback` is optional in the request and the
  conversation agent passes one only for ordered-delivery flows; group
  status tracking is not as load-bearing as direct sends.
- `send-typing-indicator` requires a prior conversation with the
  recipient (Sendblue returns 400 `No route mapping found` otherwise).
- Endpoints not implemented yet but documented by Sendblue:
  `evaluate-service`, `send-carousel`, `modify-group`,
  `upload-media-object`, the v2 `messages` resource, `mark-read`-style
  contact opt-in / opt-out, webhook registration CRUD. See
  `scripts/e2e/sendblue-webhooks.ts` for the one place we currently
  call `/api/account/webhooks` outside this client.
