# identity-lookup

A stub for `USER_LOOKUP_URL` that returns a hardcoded identity for two
phone numbers. This is **not** a chat endpoint — it's the companion
service that resolves an inbound phone number to a userId before the agent
calls your chat endpoint.

Because it answers a different route (`/lookup`, not `/chat`) and uses a
different request shape, it is **not** a target for `npm run example:chat`.
Run it alongside any of the chat examples to see the `identity` block
appear inside chat requests.

## Run

```bash
node examples/identity-lookup/server.js
# then
USER_LOOKUP_URL=http://localhost:4002/lookup
```

In a second terminal, run any chat example (e.g.
`npm run example:chat -- showcase-bot`) and the agent will enrich each
inbound message with the identity block before forwarding to the chat
endpoint.

## Built-in identities

| Phone number       | userId       | Plan |
| ------------------ | ------------ | ---- |
| `+15551234567`     | `user_alice` | pro  |
| `+15557654321`     | `user_bob`   | free |

Any other number returns `null` (the agent treats this as fail-open).

## Request / response shape

```bash
curl -s http://localhost:4002/lookup \
  -H 'content-type: application/json' \
  -d '{"resolveBy":"phone","phoneNumber":"+15551234567","lineNumber":"+15557654321","conversationKey":"direct:+15557654321:+15551234567"}'
```

```json
{
  "userId": "user_alice",
  "data": {
    "name": "Alice Example",
    "plan": "pro",
    "locale": "en-US",
    "timezone": "America/New_York"
  }
}
```
