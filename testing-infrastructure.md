# Testing Infrastructure

## Context

Sendblue does not provide a webhook simulator, a "fire test webhook" button, or any sandbox-to-sandbox iMessage flow. The only way to trigger a real `receive` webhook is to have a real iMessage-capable device send a message to the Sendblue line. This means testing infrastructure isn't a nice-to-have — it's load-bearing. Without it, every change requires manually texting from a phone and eyeballing the logs.

The test harness has two tiers: unit tests that run anywhere without hardware, and end-to-end tests that drive real iMessages using native macOS tooling. Rich messaging features (tapbacks, reactions, send effects) are covered entirely by the unit tier using captured webhook fixtures — these don't need real iMessages to validate because the agent only ever sees Sendblue's JSON payload, regardless of how it originated.

## Fixture Capture (Do This First)

Before writing any tests, capture real Sendblue webhook payloads. This is a one-time manual process that produces the JSON fixtures used by the unit test tier and confirms undocumented API details (most importantly, the webhook signing header name that Sendblue doesn't publish in their docs).

**Setup:**

1. Start ngrok: `ngrok http 3000`. Note the `https://xxxx.ngrok-free.app` URL.
2. Configure the ngrok URL as the webhook endpoint in the Sendblue dashboard for the `receive` and `outbound` webhook types.
3. Open ngrok's request inspector at `http://localhost:4040`.
4. Stand up a minimal Express server on port 3000 that accepts POST requests on `/webhook/receive` and `/webhook/status`, logs the full request (headers + body), and returns 200.

**Capture each interaction type:**

Using your phone, send each of the following to your Sendblue number and save the raw webhook payload (headers and body) from the ngrok inspector as a JSON fixture file:

- A plain text message
- An image
- A video
- A file attachment
- Each of the six classic tapback types (heart, thumbs up, thumbs down, haha, !!, ?) on a previous message
- A message with a send effect (celebration, fireworks, slam, etc.)
- A group message (if you have a group conversation with the Sendblue number)
- A message from a non-iMessage number (to capture `was_downgraded: true` / SMS fallback)

Also send an outbound message via Sendblue's API (`POST https://api.sendblue.co/api/send-message` with a `status_callback` pointing at your ngrok URL) and capture the full sequence of status callback payloads as the message progresses through `REGISTERED → PENDING → QUEUED → ACCEPTED → SENT → DELIVERED`.

**What to save:**

For each capture, save both the headers and the body. The headers are critical for the first capture — this is where you'll find the webhook signing secret header name that Sendblue doesn't document. Once you've identified it, note it in the repo's configuration docs.

Store fixtures in a `/test/fixtures/` directory, organized by type:

```
test/fixtures/
  receive/
    text-message.json
    image.json
    video.json
    file.json
    tapback-heart.json
    tapback-thumbs-up.json
    tapback-thumbs-down.json
    tapback-haha.json
    tapback-exclamation.json
    tapback-question.json
    send-effect-celebration.json
    group-message.json
    sms-fallback.json
  status-callback/
    full-lifecycle.json
    error-4001-rate-limited.json
  headers/
    webhook-headers.json
```

This process takes about 30 minutes. After this, you never need the phone for testing these scenarios again.

## Tier 1: Unit Tests (No Hardware)

### Purpose

Cover the core logic — webhook parsing, status lifecycle handling, chat endpoint integration, error handling, and all rich messaging scenarios — by replaying the captured fixtures against the handler code with mocked outbound calls. These should be fast (target: full suite under 30 seconds), deterministic, and runnable in CI on Linux.

### Test Framework

Use **Vitest**. It's fast, has native ESM support, and TypeScript works out of the box without extra configuration. The Node.js ecosystem has largely moved to Vitest for new projects, and since this is a greenfield repo there's no reason to carry Jest's configuration overhead.

### What to Test

The unit tier should cover the following functional areas. This is not an exhaustive list of individual tests — it's the territory the developer should cover:

**Webhook ingestion:** Parse Sendblue's `receive` webhook payload correctly. Handle edge cases: missing fields, unexpected values, media URLs present vs. absent, group vs. individual messages, `was_downgraded: true` vs. `false/null`. Verify that the webhook signing secret (using the header name confirmed during fixture capture) is validated and unsigned requests are rejected.

**Status callback handling:** Track outbound messages through the full lifecycle (`REGISTERED → PENDING → QUEUED → ACCEPTED → SENT → DELIVERED`). Handle the `DECLINED` branch. Handle terminal `ERROR` with the documented error codes (`4000`, `4001`, `4002`, `5000`, `5003`, `5509`, `10001`, `10002`, `SMS_LIMIT_REACHED`). Verify that `message_handle` is used for deduplication when Sendblue retries on 5xx.

**Chat endpoint integration:** Verify the request payload sent to the developer's chat endpoint matches the expected contract. Verify that the AI response is correctly routed back through Sendblue's `send-message` API. Handle chat endpoint failures (timeouts, 5xx, malformed responses) gracefully.

**Tapbacks and reactions:** Replay each captured tapback fixture and verify the agent correctly parses the tapback type, identifies the referenced message, and forwards the reaction to the chat endpoint in the expected format. Test outbound tapbacks (if Sendblue's API supports them) by asserting the correct API call is made.

**Send effects:** Replay the captured send effect fixture and verify the agent parses the `send_style` field and includes it in the chat endpoint payload. Test outbound effects by asserting the `send_style` parameter is included in the Sendblue `send-message` API call when the chat endpoint response specifies one.

**Media handling:** Replay image, video, and file fixtures. Verify `media_url` is parsed and forwarded to the chat endpoint. Test outbound media by asserting `media_url` is included in the API call.

**SMS fallback:** When `was_downgraded` is `true`, verify the agent detects SMS mode, informs the chat endpoint, and suppresses iMessage-specific features on subsequent outbound messages in that conversation.

**Group messages:** Verify `group_id`, `participants`, and `group_display_name` are parsed and forwarded to the chat endpoint with the correct structure.

### Mocking

For outbound HTTP calls to Sendblue's API, use `nock` (or Vitest's built-in mocking if sufficient) to intercept requests to `https://api.sendblue.co/api/send-message` and return controlled responses. This lets you assert on what the agent *sends* to Sendblue without hitting the real API.

### Important Notes

- Do not assert on a `READ` status. It's not in Sendblue's formal status contract.
- The fixtures captured during initial setup are the source of truth for payload shapes. If Sendblue changes their payload format, re-capture fixtures and update tests accordingly — but you'll know about the change because your parsing code will break.
- Rich messaging coverage (tapbacks, effects, media, SMS fallback) lives entirely in this tier. The agent's handling of these features is fully testable with mocked payloads because the agent never interacts with iMessage directly — it only sees Sendblue's JSON representation.

## Tier 2: End-to-End Tests (Real iMessages)

### Purpose

Validate the core text pipeline: a real iMessage is sent to the Sendblue line → Sendblue fires the `receive` webhook → the agent processes it and calls the chat endpoint → the AI response is sent back via Sendblue → the response arrives as a real iMessage on the test Mac. This catches issues that unit tests can't: webhook delivery timing, Sendblue API behavior under real conditions, iMessage delivery quirks, and status callback accuracy.

E2E tests cover the text send/receive loop. Rich messaging features (tapbacks, effects) are not tested E2E — they are covered by the unit tier with captured fixtures.

### Tooling: osascript + sqlite3

The E2E tier uses two native macOS tools with zero dependencies:

**Sending messages — `osascript` (AppleScript):**

```bash
osascript -e 'tell application "Messages" to send "TEST_<uuid> hello bot" to buddy "+1SENDBLUE_NUMBER" of service "iMessage"'
```

This sends a real iMessage from the Mac's signed-in Apple ID to the Sendblue line. It's a single shell command, executes in ~1 second, and is completely reliable for text messages.

**Reading responses — `sqlite3` on `chat.db`:**

```bash
sqlite3 -readonly ~/Library/Messages/chat.db "SELECT text, date FROM message WHERE handle_id = (SELECT ROWID FROM handle WHERE id = '+1SENDBLUE_NUMBER') AND is_from_me = 0 ORDER BY date DESC LIMIT 1;"
```

This reads the most recent incoming message from the Sendblue number. The test script polls this query on a short interval (e.g., every 500ms) until a response matching the test UUID arrives or the timeout expires.

**Requirements:**
- The Mac must be signed into an Apple ID in Messages.app with iMessage enabled.
- Full Disk Access must be granted to Terminal (or whatever shell runs the tests) for `chat.db` access. Configure in System Settings → Privacy & Security → Full Disk Access.
- The Mac must stay awake during test sessions. In System Settings → Energy, enable "Prevent automatic sleeping when the display is off." If using a MacBook, the lid must remain open.

### Local Dev Tunneling

Sendblue needs to reach the agent's webhook endpoint, which during development is running on localhost. Use **ngrok** to expose the local server.

```bash
ngrok http 3000
```

Take the generated `https://xxxx.ngrok-free.app` URL and configure it as the webhook URL in the Sendblue dashboard (or via the webhook registration API). The ngrok URL changes on every restart unless you're on a paid plan with reserved domains — update the Sendblue webhook config accordingly.

The developer is responsible for configuring the Sendblue dashboard (webhook URLs, verified contacts, etc.). The docs should flag what needs to be configured, but the configuration itself is a manual step.

### The E2E Test Loop

Each end-to-end test follows this pattern:

1. **Send:** The test script sends an iMessage to the Sendblue line via `osascript`. Include a unique test identifier (UUID) in the message body so the response can be correlated.

2. **Wait for inbound processing:** The test script watches for the agent's webhook handler to receive the Sendblue `receive` event. This can be observed via the agent's own logs or a test-specific event emitter.

3. **Wait for outbound delivery:** The test script watches for the Sendblue `status_callback` to reach `DELIVERED` (or `SENT` for SMS). Set a reasonable timeout — 15-30 seconds for iMessage delivery is typical during development.

4. **Verify response received:** The test script polls `chat.db` via `sqlite3` for messages in the test conversation newer than the test start time. Assert that a response matching the test UUID's conversation is present and arrived within the expected SLA.

5. **Assert:** Validate the full round trip — correct message content, correct status lifecycle, no errors, delivered as iMessage (not downgraded to SMS unless that's the test case).

### Test Utilities

A few utilities worth building early to make E2E tests ergonomic:

- **`sendTestMessage(content)`** — wraps the `osascript` call, injects a UUID prefix, returns the UUID for correlation.
- **`pollForResponse(conversationId, sinceTimestamp, timeout)`** — polls `chat.db` at a fixed interval until a new incoming message appears or the timeout expires.
- **`waitForStatusCallback(messageHandle, targetStatus, timeout)`** — listens for the agent's status callback handler to receive the target status for a given message handle.
- **`clearTestState()`** — optional cleanup between test runs (reset any in-memory conversation state in the agent).

### What to Test E2E

The E2E tier is not for exhaustive coverage — that's what unit tests are for. E2E tests should cover the critical paths that can only be validated with real messages:

- Basic text round trip (send message → get AI response as iMessage)
- Multi-message burst (send 3 messages quickly via separate `osascript` calls → verify they're buffered into a single AI call, once buffering is implemented in v0.2)
- Status lifecycle (verify a sent message progresses through `QUEUED → ACCEPTED → SENT → DELIVERED` via real status callbacks)
- Error recovery (simulate chat endpoint failure → verify the agent handles it gracefully and doesn't leave the conversation in a broken state)
- Latency (measure and log the round-trip time from `osascript` send to `chat.db` response arrival — useful for tracking regressions)

### What NOT to Test E2E

The following are tested in the unit tier with captured fixtures and do not need real iMessages:

- Tapback handling (all six types, plus outbound)
- Send effects (inbound parsing, outbound `send_style` parameter)
- Media handling (inbound `media_url` parsing, outbound media delivery)
- SMS fallback (`was_downgraded` detection and behavior adaptation)
- Group message routing
- Error code handling (all Sendblue error codes)
- Webhook signing validation

### Running Tests

E2E tests should be runnable as a Vitest suite (same framework as unit tests) but in a separate test directory or with a separate config that marks them as requiring macOS + iMessage + ngrok + Sendblue prerequisites. They should not run in CI by default — only locally on a Mac.

```bash
# Unit tests (anywhere, no hardware)
npm test

# E2E tests (requires macOS + iMessage + ngrok + Sendblue)
npm run test:e2e
```

### chat.db Considerations

A few things to be aware of when querying `chat.db`:

- **Timestamps:** `chat.db` uses Apple's CoreData timestamp format (nanoseconds since 2001-01-01). The test utilities should handle the conversion to/from JavaScript Date objects.
- **AttributedBody:** On newer macOS versions (especially with RCS support), some message content is stored in the `attributedBody` blob column rather than `text`. The `text` column may be null even when a message has content. The polling utility should check `attributedBody` as a fallback and decode it appropriately.
- **Database locking:** `chat.db` is a live database that Messages.app writes to continuously. Open it in read-only mode (`sqlite3 -readonly`) to avoid contention.
- **Message deduplication:** Messages can appear in `chat.db` before they're fully "delivered" from the user's perspective. Use the `date_delivered` column (for incoming) or `date_read` column to determine finality if needed.
