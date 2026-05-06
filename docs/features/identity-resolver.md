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

It accepts either `null` or an object with a non-empty `userId` string and an
optional opaque `data` field:

```json
{
  "userId": "user-123",
  "data": {
    "tier": "gold"
  }
}
```

Resolver failures fail open. The agent logs the failure, continues processing,
and sends the chat request with `identity: null`. Successful identity values are
stored on the conversation record and reused for that conversation.

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
- `CHAT_ENDPOINT_URL` - receives the enriched chat request.
- `REDIS_URL` - stores resolved identity durably when configured.

## Known limitations

- There is no separate timeout setting for `USER_LOOKUP_URL`; the HTTP resolver
  currently relies on default `fetch` behavior.
- Identity is cached on the conversation record until the conversation TTL
  expires or the record is overwritten; there is no explicit refresh policy yet.
- The resolver only supports phone-based lookup in v0.2.
