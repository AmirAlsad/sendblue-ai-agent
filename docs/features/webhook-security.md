# Webhook Security

## What it does

Authenticates inbound Sendblue webhook requests using Sendblue's documented
shared-secret header, drops unauthenticated traffic before it reaches the
conversation state machine, and pins HTTP response codes to match Sendblue's
documented retry behavior so transient mistakes do not get retried in a tight
loop.

## How it works

Sendblue authenticates outbound webhook deliveries by sending a shared secret
in a request header. The official documentation (see
[https://docs.sendblue.com/security](https://docs.sendblue.com/security))
specifies:

> Sendblue sends `sb-signing-secret` header with requests. Verify this matches
> your configured secret.

This is a literal string comparison, not an HMAC over the request body or the
URL. Each webhook entry can carry its own secret, or an account-wide
`globalSecret` can apply to all webhooks (see the registration section below).

The `validateWebhookSecret` helper in `src/http/security.ts` runs at the start
of every webhook route in `src/http/app.ts`:

- If `SENDBLUE_WEBHOOK_SECRET` is unset, validation is disabled (useful for
  local-only smoke runs without a public endpoint). All requests are accepted.
- If `SENDBLUE_WEBHOOK_SECRET` is set, the request must present the secret on
  either the configured `SENDBLUE_WEBHOOK_SECRET_HEADER` (defaulting to
  `sb-signing-secret`) or the literal `sb-signing-secret` header.
- The comparison uses `crypto.timingSafeEqual` to avoid leaking the secret via
  response timing. Length-mismatched buffers spend the same comparison time and
  return false.

When validation fails, the route logs a structured warning with the path, the
present `sb-`-prefixed header names (but never their values), the remote IP,
and the user agent, then returns `401 Unauthorized`.

### Status code policy and retries

Sendblue's documented retry behavior is:

> Sendblue retries webhook delivery up to 3 times if your endpoint returns a
> 5xx server error. Sendblue waits 45 seconds for a response from your
> endpoint.

The HTTP app deliberately maps every non-success outcome to a 4xx code so
Sendblue does not retry. Transient retry of the underlying work (chat endpoint
call, Sendblue outbound delivery) is the responsibility of the conversation
agent and outbound queue, not Sendblue's webhook retry loop.

| Outcome | Status |
| --- | --- |
| Health probe | 200 |
| Receive accepted (buffering or processed) | 202 |
| Receive deduplicated by `message_handle` | 200 |
| Status callback handled | 200 |
| Typing indicator handled | 202 |
| Operational webhook handled | 202 |
| Invalid webhook secret | 401 |
| Malformed payload | 400 |
| Downstream chat endpoint failure | 502 |

The 502 on chat-endpoint failure is intentionally not retried by Sendblue: the
conversation agent already absorbs the failure and acknowledges the inbound
webhook so the user does not see Sendblue retry storms. If a future change
makes downstream failure retryable by Sendblue, switch that path to a 5xx and
update this document.

### Idempotency

Sendblue does not guarantee single delivery. Per the docs, "your webhook
endpoints should be idempotent, as they may receive duplicate events". The
receive route hands every request to `ConversationAgent.handleReceive`, which
claims `message_handle` against the configured store before doing any
irreversible work. Duplicate receives short-circuit with `200 { ok: true,
duplicate: true }`. The status route applies updates with adjacent-state
deduplication so retries do not pollute history.

### Webhook registration

Registration is implemented in `scripts/e2e/sendblue-webhooks.ts` and the
helpers in `scripts/e2e/lib/sendblue-webhooks.ts`. The script can run in two
modes:

- `npm run sendblue:webhooks` — registers `receive` and `outbound` webhooks
  with the configured secret. This is the minimum for the v0.1 transport loop.
- `npm run sendblue:webhooks -- --all` — registers every Sendblue webhook type
  (`receive`, `outbound`, `typing_indicator`, `call_log`, `line_blocked`,
  `line_assigned`, `contact_created`). Used for capture sessions where every
  inbound shape must be observed.

The script lists existing webhooks via `GET /api/account/webhooks`, then
either adds missing entries via `POST /api/account/webhooks` or replaces the
whole config via `PUT /api/account/webhooks` if any managed entry needs to be
updated. Because Sendblue's PUT body is "complete replacement, any webhooks
not included in the request will be removed", the helper preserves existing
unmanaged entries and the account `globalSecret` when constructing the
replacement payload.

`contact_created` is sent as a plain URL string instead of a
`{ url, secret }` object because Sendblue's API rejects object values for that
type as of writing. The shared `globalSecret` still applies.

### TLS

Sendblue auto-upgrades HTTP webhook URLs to HTTPS, so registered URLs in
production must terminate TLS. The local `npm run dev:e2e` flow handles this
through ngrok.

## Code files

| File | Role |
| --- | --- |
| `src/http/app.ts` | Express route composition, response code policy, structured logging on auth and parse failures. |
| `src/http/security.ts` | Constant-time shared-secret validation against `sb-signing-secret` and the configured header alias. |
| `src/sendblue/webhook-types.ts` | Canonical list of webhook types and route paths. |
| `scripts/e2e/sendblue-webhooks.ts` | CLI entry point for `npm run sendblue:webhooks`. |
| `scripts/e2e/lib/sendblue-webhooks.ts` | Sendblue webhook list/create/replace API client. |
| `tests/integration/app-flow.test.ts` | End-to-end coverage including secret validation, malformed payloads, and route registration pinning. |
| `tests/unit/e2e-setup/sendblue-webhooks.test.ts` | Unit coverage for the registration helpers. |
| `tests/integration/e2e-setup/sendblue-webhook-client.test.ts` | Integration coverage for the registration client. |

## Configuration

- `SENDBLUE_WEBHOOK_SECRET` — the shared secret Sendblue includes in the
  `sb-signing-secret` header. When unset, webhook authentication is disabled
  (only acceptable for local-only smoke runs).
- `SENDBLUE_WEBHOOK_SECRET_HEADER` — secondary accepted header name. Defaults
  to `sb-signing-secret`. Configurable to support legacy installs that may
  have used a different header before Sendblue documented the canonical one.
- `PUBLIC_BASE_URL` — used by the registration script to compute webhook URLs
  (`<PUBLIC_BASE_URL>/webhook/receive`, etc.).

## Known limitations

- Sendblue does not (yet) document an HMAC signature scheme. The `sb-signing-
  secret` value is the literal configured secret. If Sendblue switches to a
  body-signing HMAC, both `validateWebhookSecret` and the registration script
  must change.
- The registration script is additive/replacing; it does not delete stale
  webhooks. To clear an account's webhook list, use the Sendblue dashboard or
  call `DELETE /api/account/webhooks` directly.
- `typing_indicator` registration is documented but observed to be account/
  API-gated. The route is mounted regardless and is safe to leave registered.
- The 401 path does not surface the rejected header value to logs by design.
  If you need to debug a misconfigured Sendblue account, look at the
  `presentSendblueHeaders` field in the warning log to confirm the header was
  sent at all, then compare your stored `SENDBLUE_WEBHOOK_SECRET` with the
  Sendblue dashboard.
