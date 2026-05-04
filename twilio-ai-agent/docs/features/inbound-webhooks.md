# Inbound Webhooks

## What it does

Accepts Twilio SMS / WhatsApp / RCS webhooks, validates signatures in production, and routes inbound messages into the conversation state machine. RCS messages arrive on the same `/sms/webhook` endpoint as SMS (Twilio treats them as the same channel with the `rcs:` prefix on the `From` field).

## How it works

The package exposes `/sms/webhook` and `/whatsapp/webhook`. The handler normalizes phone numbers, resolves the user via the configured adapter, runs the optional eligibility gate, and dispatches the message based on the per-conversation state. In production (`NODE_ENV=production`), the Twilio signature is verified before any processing. Responses return empty TwiML immediately and processing continues asynchronously.

After user resolution and before any state-machine work, the handler invokes the gate (if enabled) and decides whether the inbound passes. Blocked users get a rate-limited redirect message via `sendRedirectIfDue` (channel-mirrored — SMS in produces SMS out, WhatsApp in produces WhatsApp out). The handler then returns without buffering anything or calling the chat endpoint.

If the user adapter returns `null` (unknown phone), the handler optionally sends `UNKNOWN_USER_MESSAGE` (if configured) and drops the inbound. With no fallback message configured, the inbound is silently ignored.

For WhatsApp messages, the handler also captures `OriginalRepliedMessageSid` from the Twilio POST body. When present, it performs a Redis lookup against the read-receipt SID mapping to resolve the original send timestamp, then stores a structured buffer item (`{text, repliedToSid, repliedToSentAt}`) instead of a plain string. This reply context flows through the buffer pipeline to the chat endpoint as `repliedToSid` / `repliedToSentAt` fields.

The handler stores the inbound `MessageSid` as `lastInboundSid` in the Redis conversation state. This SID is used by the buffer timer worker and trigger processor to fire WhatsApp typing indicators before calling the chat endpoint.

The user-adapter's opaque `data` field is JSON-serialized and stored in state under `userData`, then forwarded to the chat endpoint as `user` when the buffer timer fires. The package itself doesn't interpret it.

## Code files

| File | Role |
| --- | --- |
| `src/index.js` | Express server, Twilio signature validation, routes |
| `src/routes/webhook-handler.js` | Shared SMS/WhatsApp webhook logic |
| `src/routes/sms-webhook.js` | SMS route wiring |
| `src/routes/whatsapp-webhook.js` | WhatsApp route wiring |
| `src/utils/twilio-client.js` | Twilio client setup |
| `src/utils/gate.js` | Optional eligibility gate — predicate evaluation + redirect dispatch |
| `src/adapters/user-adapter.js` | User resolution (HTTP webhook or JS file) |

## Configuration

- `NODE_ENV=production` — enforces Twilio signature validation
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` — required for Twilio
- `TWILIO_MESSAGING_SERVICE_SID` — recommended for outbound (enables RCS-first / SMS fallback)
- `USER_LOOKUP_URL` — HTTP user-adapter URL (or use `./adapters/user.js`)
- `UNKNOWN_USER_MESSAGE` — optional reply when an inbound's phone resolves to no user

## Known limitations

- Signature validation requires the public URL to match Twilio configuration exactly (proxy headers handled via `x-forwarded-proto`)
- Unknown phones are dropped (or get `UNKNOWN_USER_MESSAGE`) — no auto-onboarding flow built in
