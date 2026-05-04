# Chat-endpoint contract

`twilio-ai-agent` POSTs to `CHAT_ENDPOINT_URL` for every inbound message
(after buffering settles) and every fired trigger. Your endpoint can be in
any language — only the JSON shape matters.

## Request

```http
POST $CHAT_ENDPOINT_URL
Content-Type: application/json
```

```json
{
  "userId": "string",
  "phoneNumber": "+15551234567",
  "message": "aggregated buffered text OR trigger.message",
  "interface": "sms",
  "stream": true,

  "repliedToSid": "SMxxxx...",
  "repliedToSentAt": "2026-05-03T12:34:56.000Z",

  "trigger": {
    "id": "uuid",
    "type": "optional-string",
    "metadata": { "anything": "the caller passed" }
  },

  "user": { "tier": "paid", "name": "Alice" }
}
```

Field semantics:

- `userId` — From the user-adapter's resolution; opaque string.
- `phoneNumber` — E.164. The `whatsapp:` prefix is already stripped.
- `message` — For inbound: rapid-fire messages aggregated with `\n---\n` delimiters. For triggers: the trigger payload's `message` verbatim.
- `interface` — `sms` or `whatsapp`.
- `stream` — Always `true` for buffered inbound and triggers (the package always uses streaming for these). Your endpoint can ignore it and return blocking JSON if you don't support streaming — content-type negotiation handles the fallback.
- `repliedToSid` / `repliedToSentAt` — Present only for WhatsApp messages where the user swipe-replied to a previous outbound. Look up the original message in your own store if you want to enrich the prompt.
- `trigger` — Present only on trigger-driven calls. `metadata` is opaque; the package forwards whatever the trigger source passed.
- `user` — Present only when the user-adapter returned a `data` field; opaque blob, forwarded as-is.

## Response — blocking JSON

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "success": true,
  "messages": ["first reply", "second reply"],
  "silence": false,
  "fallbackMessage": "optional",
  "metadata": { "anything": "the package logs but does not act on it" }
}
```

- `success: false` puts the conversation back to IDLE. If `fallbackMessage` is set, it's sent verbatim via Twilio.
- `silence: true` means the AI deliberately chose not to reply. The package transitions to IDLE without sending anything.
- `messages` is sent in order; one Twilio message per array element.

## Response — streaming NDJSON

```http
HTTP/1.1 200 OK
Content-Type: application/x-ndjson
```

One JSON object per line, terminated by `\n`:

```
{"type":"message","index":0,"text":"first reply"}
{"type":"message","index":1,"text":"second reply"}
{"type":"done","success":true,"silence":false,"metadata":{...}}
```

The `done` line carries the same shape as the blocking JSON response, minus
the `messages` array (it was streamed). If the stream ends without a `done`
line, the package treats it as `{success: true, streamed: true}` and the
already-streamed messages are sent.

NDJSON is preferred for latency: the first message can leave the chat
endpoint before the model finishes generating subsequent messages.

## Read-receipt callback (optional)

If `READ_RECEIPT_URL` is set, the package POSTs there when Twilio reports a
`read` status (RCS / WhatsApp / iMessage). Otherwise read events are
logged at debug and dropped.

```http
POST $READ_RECEIPT_URL
Content-Type: application/json
```

```json
{
  "userId": "string",
  "messageTimestamp": "2026-05-03T12:34:56.000Z",
  "readAt": "2026-05-03T12:35:01.000Z",
  "channel": "sms"
}
```

Any 2xx is fine; the body isn't read.

## Runnable references in this repo

- `examples/mock-services/chat-endpoint.js` — a 30-line echo, used by the README quickstart.
- `examples/test-chat-endpoint/` — a programmable Express server implementing the same contract with a script queue, rule matchers, NDJSON streaming, configurable delays, failure injection, and a `/_admin/calls` inspector. Useful as a deterministic stand-in for your AI in integration tests, manual smoke tests, or local dev. See its `README.md` for the admin HTTP API.

## Reference Node implementation

```js
// minimal Express; mirrors what twilio-ai-agent expects
import express from 'express';

const app = express();
app.use(express.json());

app.post('/chat', async (req, res) => {
  const { userId, phoneNumber, message, interface: channel, trigger, user } = req.body;

  // Pretend this calls Anthropic / OpenAI / your model.
  const replies = ['Got it: ' + message];

  if (req.body.stream) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    for (let i = 0; i < replies.length; i++) {
      res.write(JSON.stringify({ type: 'message', index: i, text: replies[i] }) + '\n');
    }
    res.write(JSON.stringify({ type: 'done', success: true, silence: false }) + '\n');
    res.end();
  } else {
    res.json({ success: true, messages: replies });
  }
});

app.post('/user-lookup', async (req, res) => {
  const { resolveBy, value } = req.body;
  // ... your lookup
  res.json({ userId: 'u_1', phone: '+15551111111', channel: 'sms', data: {} });
});

app.listen(3000);
```
