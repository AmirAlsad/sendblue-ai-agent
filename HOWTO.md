# HOWTO: Run twilio-ai-agent locally

A 5-minute path from `git clone` to a working SMS exchange.

## Prerequisites

- Node.js 18+
- Redis (local `redis-server` or hosted)
- Twilio account with a Messaging Service SID + a phone number
- A running chat endpoint that implements the contract in `examples/chat-endpoint-pseudocode.md`. For first-run sanity, use the bundled mocks in `examples/mock-services/`.
- ngrok (or any HTTP tunnel) — Twilio webhooks need a public URL

## Steps

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env: fill in TWILIO_*, REDIS_URL, CHAT_ENDPOINT_URL, USER_LOOKUP_URL,
#            STATUS_CALLBACK_URL (the ngrok URL you'll get in step 5),
#            TRIGGER_API_KEY (any random string).

# 3. Start Redis (skip if you've pointed REDIS_URL at a hosted instance)
redis-server &

# 4. Start the bundled mock chat + user-lookup services (optional; skip if
#    you have your own running). The bare echo is enough for a smoke test;
#    swap in examples/test-chat-endpoint/server.js when you want a
#    programmable endpoint (script queue, NDJSON streaming, failure
#    injection, call inspection — see its README).
node examples/mock-services/user-lookup.js &     # Listens on :4000
node examples/mock-services/chat-endpoint.js &   # Listens on :4001

# 5. Tunnel + start the agent
ngrok http 3001 &
npm run dev

# 6. Configure Twilio
# In the Twilio console, set your phone number's "When a message comes in"
# webhook to https://<your-ngrok>.ngrok.io/sms/webhook  (or .../whatsapp/webhook)
# and the status callback to https://<your-ngrok>.ngrok.io/status/callback
```

Send an SMS to your Twilio number from a phone listed in the mock user-lookup dict. You should see the inbound webhook hit, the buffer timer fire after ~2 seconds, the chat endpoint receive the payload, and the echoed reply land on your phone.

## Sending a trigger

```bash
curl -X POST http://localhost:3001/triggers \
  -H "X-Trigger-API-Key: $TRIGGER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-1",
    "message": "Hey, your timer just fired.",
    "timestamp": "2026-05-03T12:00:00Z",
    "metadata": {"source": "my-scheduler"}
  }'
```

The chat endpoint will receive a payload with `interface: 'sms'` (or `'whatsapp'`) and `trigger: {id, metadata: {...}}`. Return a normal NDJSON or JSON response and the user gets the message.

## Health

```bash
curl http://localhost:3001/health
curl http://localhost:3001/triggers/health
```

## Debug routes (development only)

```bash
curl http://localhost:3001/debug/state/+15551234/sms
curl -X DELETE http://localhost:3001/debug/state/+15551234/sms
```

These endpoints are gated on `NODE_ENV !== 'production'`.

## Tests

```bash
npm run test:unit              # zero-dep unit tests
npm run test:integration       # end-to-end behavior tests (needs Redis running)
npm test                       # both
```

The integration suite needs Redis on `localhost:6379` (uses db 15 to avoid colliding with developer state; override via `TEST_REDIS_URL`). On macOS: `brew install redis && redis-server --daemonize yes`. CI uses a Redis service container — see `.github/workflows/ci.yml`.

To drive the test chat endpoint manually or from a non-Node test runner, start the standalone version: `node examples/test-chat-endpoint/server.js`. Its admin HTTP API (`/_admin/script`, `/_admin/rule`, `/_admin/calls`, `/_admin/reset`) is documented in `examples/test-chat-endpoint/README.md`.
