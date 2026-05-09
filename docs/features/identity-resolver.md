# Identity Resolver

## What it does

Optionally enriches chat endpoint requests with an application-level user
identity resolved from the inbound phone number and Sendblue line.

## How it works

Identity resolution is optional. If no resolver is injected and `USER_LOOKUP_URL`
is unset, chat requests include `identity: null`.

There are two supported integration paths:

- Dependency injection through `createApp({ identityResolver })`.
- HTTP lookup through `USER_LOOKUP_URL`, which creates `HttpIdentityResolver`.

The resolver interface is:

```ts
type IdentityResolver = {
  resolveByPhone(input: {
    phoneNumber: string;
    lineNumber: string;
    conversationKey: string;
  }): Promise<{ userId: string; data?: unknown } | null>;
};
```

The HTTP resolver posts:

```json
{
  "resolveBy": "phone",
  "value": "+15551110001",
  "phoneNumber": "+15551110001",
  "lineNumber": "+15552220000",
  "conversationKey": "direct:+15552220000:+15551110001"
}
```

It accepts either `null` or an object with a non-empty `userId` string. Optional
fields are forwarded:

- `data` — opaque, passed through to the chat endpoint untouched.
- `authorized` — boolean. When `false` and `VALID_USER_REQUIRED=true`, the agent
  acks the inbound silently without calling the chat endpoint.
- `firstName`, `lastName`, `tags`, `customVariables` — used by the optional
  Sendblue contact upsert flow (see `docs/features/contact-upsert.md`). Ignored
  when `SENDBLUE_CONTACTS_ENABLED=false`.

```json
{
  "userId": "user-123",
  "data": { "tier": "gold" },
  "firstName": "Ada",
  "lastName": "Lovelace",
  "tags": ["tier:gold", "beta"],
  "customVariables": { "plan": "agent" }
}
```

Resolver failures fail open. The agent logs the failure, continues processing,
and sends the chat request with `identity: null`. Successful identity values are
stored on the conversation record and reused for that conversation. Fail-open
semantics are enforced in `ConversationAgent.resolveIdentity` (it catches and
logs any rejection from the resolver); `HttpIdentityResolver` therefore throws
on transport errors, request timeouts, non-2xx responses, and invalid JSON so
those failures show up in logs instead of being silently coerced to "no
identity".

`HttpIdentityResolver` enforces a request timeout via `AbortSignal.timeout`,
defaulting to `IDENTITY_RESOLVER_TIMEOUT_MS` (5000 ms). Setting the timeout to
`0` disables the timeout. Identity lookup runs inline before the chat call, so
a hung upstream lookup would otherwise stall buffering and outbound delivery.

If the body is `null`, an array, a primitive, or an object whose `userId` is
missing/blank, the resolver returns `null` (not a rejection): a malformed
"no match" payload is treated the same as "no identity for this number".

Sendblue exposes a Contacts API (`GET /api/v2/contacts/:phone_number`) for
operator-managed contact metadata, but the package intentionally does not fall
back to it: that data is operator/CRM contact info, not application user
identity. Resolution remains the developer's responsibility through
`USER_LOOKUP_URL` or a custom `identityResolver` injected into `createApp`.

The package does not interpret `identity.data`; it is passed through to the chat
endpoint so the application can apply its own account, profile, or CRM context.

## Code files

| File | Role |
| --- | --- |
| `src/identity/resolver.ts` | Resolver interface and HTTP implementation |
| `src/http/app.ts` | Resolver construction and dependency injection |
| `src/conversation/agent.ts` | Per-conversation lookup, caching, fail-open behavior |
| `src/conversation/chat-request.ts` | Adds identity to chat requests |
| `src/conversation/types.ts` | Conversation identity type |

## Configuration

- `USER_LOOKUP_URL` - enables HTTP identity lookup.
- `IDENTITY_RESOLVER_TIMEOUT_MS` - per-request timeout for the lookup, default
  `5000`. Set to `0` to disable.
- `VALID_USER_REQUIRED` - when `true`, a null or `authorized: false` identity
  causes the agent to silently acknowledge the inbound message without calling
  the chat endpoint.
- `CHAT_ENDPOINT_URL` - receives the enriched chat request.
- `REDIS_URL` - stores resolved identity durably when configured.

## Known limitations

- Identity is cached on the conversation record until the conversation TTL
  expires or the record is overwritten; there is no explicit refresh policy yet.
- The resolver only supports phone-based lookup in v0.2.
- Sendblue's Contacts v2 API (`GET /api/v2/contacts/:phone_number`) is not used
  as a fallback; identity is intentionally a developer-supplied concern.
