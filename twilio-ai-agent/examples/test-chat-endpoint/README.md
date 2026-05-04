# test-chat-endpoint

A programmable Express server that implements the `twilio-ai-agent` chat-endpoint contract. Built for integration tests but useful for any scenario where you need a deterministic stand-in for your real AI: manual smoke tests, local dev, regression harnesses.

The `tests/integration/helpers/chat-endpoint.js` file is a thin in-process wrapper around the same Express app — it exposes a JS API for tests that prefer direct method calls over HTTP control-plane calls.

## Run

```bash
node examples/test-chat-endpoint/server.js              # :4001 by default
PORT=4001 node examples/test-chat-endpoint/server.js
```

Point `CHAT_ENDPOINT_URL=http://localhost:4001/chat` in your `.env`.

## Behavior precedence

Per `/chat` request, the endpoint picks a response in this order:

1. **First matching rule** (in insertion order). Rules can be `once: true` (consumed on match) or evaluated every time.
2. **Next entry on the script queue** (FIFO).
3. **Default behavior** — `echo` (returns `{success: true, messages: ['echo: <input>']}`) unless overridden.

Inputs are recorded in the call log regardless of which path served them.

## Response shapes

The endpoint accepts shorthand or fully-normalized responses. All accept an optional `delayMs: N` to sleep before responding.

| Shorthand | Behavior |
|---|---|
| `{ messages: ['a', 'b'] }` | Multi-message JSON body, success:true |
| `{ silence: true }` | `{ success: true, silence: true }` |
| `{ fallbackMessage: 'oops' }` | `{ success: false, fallbackMessage: 'oops' }` |
| `{ ndjson: [{type:'message',index:0,text:'hi'}, {type:'done',success:true}] }` | NDJSON stream (Content-Type: application/x-ndjson) |
| `{ status: 503 }` | HTTP 503 (test 5xx error path) |
| `{ throw: true }` | Destroys the socket — simulates a network error |
| `{ body: {custom: 'shape'} }` | Sends body verbatim — for off-spec testing |

## Admin HTTP API

### `POST /_admin/script` — push to the FIFO queue

```json
{ "response": { "messages": ["hi"] } }
```
Or batch:
```json
{ "responses": [
  { "messages": ["first"] },
  { "silence": true },
  { "fallbackMessage": "oops" }
] }
```

### `POST /_admin/rule` — add a matcher rule

```json
{
  "matcher": { "regex": "book", "flags": "i", "path": "body.message" },
  "response": { "messages": ["I can book that."] },
  "once": false
}
```
Or exact-equals:
```json
{
  "matcher": { "equals": "u_alice", "path": "body.userId" },
  "response": { "messages": ["Hi Alice"] }
}
```

`path` is dot-notation into the request object (default `body.message`). The matcher only applies when the path resolves to a string and matches.

### `POST /_admin/default` — set the fallback behavior

```json
{ "behavior": "echo" }
{ "behavior": "response", "response": { "silence": true } }
```

### `GET /_admin/calls` — inspect what arrived

```json
{
  "calls": [
    {
      "at": "2026-05-03T12:00:00Z",
      "path": "/chat",
      "body": { "userId": "u_alice", "message": "hi", ... }
    }
  ],
  "readReceipts": []
}
```

### `POST /_admin/reset` — clear script + rules + calls

Restores `defaults` to `echo`. Use between tests.

### `GET /_admin/health` — liveness check

Returns `{ ok: true }`. Useful for spawn-and-wait loops.

## Read-receipt endpoint

The endpoint also accepts `POST /read-receipt` (so tests can also point `READ_RECEIPT_URL` at it). Every read receipt is captured into `store.readReceipts` and returned by `GET /_admin/calls`.

## In-process usage (from JS tests)

```js
const { createApp, createStore } = require('./examples/test-chat-endpoint/app');

const store = createStore();
const { app } = createApp({ store });
const server = app.listen(4001);

// Drive the store directly:
store.script.push(/* normalized response */);
store.rules.push({ matcher: req => req.body.userId === 'u1', response: {...} });
console.log(store.calls);
```

For an ergonomic wrapper, see `tests/integration/helpers/chat-endpoint.js` — it exposes `scriptNext`, `setRule`, `calls`, `reset`, etc., plus support for function matchers (which the HTTP control plane can't accept).
