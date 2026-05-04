# Testing Infrastructure

## Context

Sendblue does not provide a webhook simulator, a "fire test webhook" button, or any sandbox-to-sandbox iMessage flow. The only way to trigger a real `receive` webhook is to have a real iMessage-capable device send a message to the Sendblue line. This means testing infrastructure isn't a nice-to-have — it's load-bearing. Without it, every change requires manually texting from a phone and eyeballing the logs.

The test harness has two tiers: unit tests that run anywhere without hardware, and end-to-end tests that drive real iMessages through the full pipeline using a BlueBubbles server on a Mac.

## Tier 1: Unit Tests (No Hardware)

### Purpose

Cover the core logic — webhook parsing, status lifecycle handling, chat endpoint integration, error handling — by replaying captured Sendblue payloads against the handler code with mocked outbound calls. These should be fast (target: full suite under 30 seconds), deterministic, and runnable in CI on Linux.

### Test Framework

Use **Vitest**. It's fast, has native ESM support, and TypeScript works out of the box without extra configuration. The Node.js ecosystem has largely moved to Vitest for new projects, and since this is a greenfield repo there's no reason to carry Jest's configuration overhead.

### What to Test

The unit tier should cover the following functional areas. This is not an exhaustive list of individual tests — it's the territory the developer should cover:

**Webhook ingestion:** Parse Sendblue's `receive` webhook payload correctly. Handle edge cases: missing fields, unexpected values, media URLs present vs. absent, group vs. individual messages, `was_downgraded: true` vs. `false/null`. Verify that the webhook signing secret (once the header name is confirmed) is validated and unsigned requests are rejected.

**Status callback handling:** Track outbound messages through the full lifecycle (`REGISTERED → PENDING → QUEUED → ACCEPTED → SENT → DELIVERED`). Handle the `DECLINED` branch. Handle terminal `ERROR` with the documented error codes (`4000`, `4001`, `4002`, `5000`, `5003`, `5509`, `10001`, `10002`, `SMS_LIMIT_REACHED`). Verify that `message_handle` is used for deduplication when Sendblue retries on 5xx.

**Chat endpoint integration:** Verify the request payload sent to the developer's chat endpoint matches the expected contract. Verify that the AI response is correctly routed back through Sendblue's `send-message` API. Handle chat endpoint failures (timeouts, 5xx, malformed responses) gracefully.

**SMS fallback:** When `was_downgraded` is `true`, verify the agent's behavior changes appropriately — no iMessage-specific features, and the chat endpoint is informed of the downgrade.

### Fixtures

Capture 10–20 real webhook payloads during early development and store them as JSON fixtures in the repo. The Sendblue `receive` payload shape is documented in the overview — use that as the baseline, but real payloads from your own Sendblue account will catch undocumented fields or edge cases.

For outbound mocking, use `nock` (or Vitest's built-in mocking if sufficient) to intercept HTTP calls to `https://api.sendblue.co/api/send-message` and return controlled responses.

### Important Notes

- Do not assert on a `READ` status. It's not in Sendblue's formal status contract.
- The webhook signing header name is undocumented. Until it's confirmed, the webhook validation tests should be structured so the header name is a single configurable constant that can be updated without touching test logic.

## Tier 2: End-to-End Tests (Real iMessages)

### Purpose

Validate the full pipeline: a real iMessage is sent to the Sendblue line → Sendblue fires the `receive` webhook → the agent processes it and calls the chat endpoint → the AI response is sent back via Sendblue → the response arrives as a real iMessage on the test device. This is the highest-fidelity test possible and catches issues that unit tests can't: webhook delivery timing, Sendblue API behavior, iMessage delivery quirks, and status callback accuracy.

### Setup: BlueBubbles on Mac

BlueBubbles is an open-source iMessage bridge that runs as a macOS app. It exposes a REST API for sending messages and fires webhooks for incoming messages, which makes it programmable from test scripts.

**Installation and configuration:**

1. Install BlueBubbles Server from [bluebubbles.app](https://bluebubbles.app). Sign into an Apple ID in Messages.app on the Mac. Using a burner Apple ID is recommended for safety — it avoids test messages appearing in personal conversation history — but a personal Apple ID works fine for development.

2. Configure BlueBubbles: set a server password, enable the REST API (default port 1234).

3. Grant Full Disk Access to BlueBubbles in System Settings → Privacy & Security. This is required for BlueBubbles to read `~/Library/Messages/chat.db`.

4. Configure BlueBubbles webhooks to POST to a local endpoint that the test runner listens on (e.g., `http://localhost:3001/bb-webhook`). BlueBubbles fires events for `new-message`, `updated-message`, `typing-indicator`, and `chat-read-status-changed`.

5. Ensure the Mac stays awake during test sessions. In System Settings → Energy, enable "Prevent automatic sleeping when the display is off." If using a MacBook, the lid must remain open. Verify with `pmset -g | grep sleep`.

**Note on laptop usage:** BlueBubbles on a MacBook is appropriate for active development. If a persistent always-on test server is needed later, a Mac mini with a dedicated Apple ID is the standard community pattern. That's out of scope for now.

### Setup: Local Dev Tunneling

Sendblue needs to reach the agent's webhook endpoint, which during development is running on localhost. Use **ngrok** to expose the local server.

```bash
ngrok http 3000
```

Take the generated `https://xxxx.ngrok-free.app` URL and configure it as the webhook URL in the Sendblue dashboard (or via the webhook registration API). Remember that the ngrok URL changes on every restart unless you're on a paid plan with reserved domains — update the Sendblue webhook config accordingly.

The developer is responsible for configuring the Sendblue dashboard (webhook URLs, verified contacts, etc.). The docs should flag what needs to be configured, but the configuration itself is a manual step.

### The E2E Test Loop

Each end-to-end test follows this pattern:

1. **Send:** The test script sends an iMessage to the Sendblue line via BlueBubbles' REST API (`POST /api/v1/message/text` with `chatGuid: "iMessage;-;+1SENDBLUE_NUMBER"`). Include a unique test identifier (UUID) in the message body so the response can be correlated.

2. **Wait for inbound processing:** The test script watches for the agent's webhook handler to receive the Sendblue `receive` event. This can be observed via the agent's own logs or a test-specific event emitter.

3. **Wait for outbound delivery:** The test script watches for the Sendblue `status_callback` to reach `DELIVERED` (or `SENT` for SMS). Set a reasonable timeout — 15-30 seconds for iMessage delivery is typical during development.

4. **Verify response received:** The test script either reads the BlueBubbles `new-message` webhook (which fires when the response iMessage arrives on the Mac) or queries BlueBubbles' REST API for recent messages in the test conversation. Assert that the response body is present and arrived within the expected SLA.

5. **Assert:** Validate the full round trip — correct message content, correct status lifecycle, no errors, delivered as iMessage (not downgraded to SMS unless that's the test case).

### Test Utilities

A few utilities worth building early to make E2E tests ergonomic:

- **`sendTestMessage(content)`** — wraps the BlueBubbles API call, injects a UUID prefix, returns the UUID for correlation.
- **`waitForWebhook(type, predicate, timeout)`** — generic webhook waiter that resolves when a matching event arrives or rejects on timeout.
- **`waitForDelivery(messageHandle, timeout)`** — wraps status callback polling until `DELIVERED` or `ERROR`.
- **`getLatestResponse(conversationId)`** — reads the most recent inbound message from BlueBubbles for assertion.
- **`clearTestConversation()`** — optional cleanup between test runs.

### What to Test E2E

The E2E tier is not for exhaustive coverage — that's what unit tests are for. E2E tests should cover the critical paths that can only be validated with real messages:

- Basic text round trip (send message → get AI response as iMessage)
- Multi-message burst (send 3 messages quickly → verify they're buffered into a single AI call, once buffering is implemented in v0.2)
- Media inbound (send an image → verify the chat endpoint receives the `media_url`)
- Media outbound (AI response includes media → verify it arrives as an iMessage attachment)
- SMS fallback (send from a non-iMessage number → verify `was_downgraded` is handled)
- Status lifecycle (verify a sent message progresses through `QUEUED → ACCEPTED → SENT → DELIVERED`)
- Error recovery (simulate chat endpoint failure → verify the agent handles it gracefully and doesn't leave the conversation in a broken state)

### Running E2E Tests

E2E tests should be runnable as a Vitest suite (same framework as unit tests) but in a separate test directory or with a separate config that marks them as requiring the Mac + BlueBubbles + ngrok + Sendblue prerequisites. They should not run in CI by default — only locally or on a dedicated test machine.

The developer should be able to run:

```bash
# Unit tests (anywhere, no hardware)
npm test

# E2E tests (requires BlueBubbles + ngrok + Sendblue)
npm run test:e2e
```
