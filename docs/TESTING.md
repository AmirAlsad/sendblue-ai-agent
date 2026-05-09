# Testing Infrastructure

## Unit and Integration Tests

Run:

```bash
npm test
```

This runs:

- `tests/unit`: parser, config, status, chat contract, Sendblue client,
  contact-upsert helpers, and limit-tracker / retry tests.
- `tests/integration`: real Express app flow with injected fake chat and
  Sendblue clients, including the limit-flow retry/stall and contact-upsert
  flows.

These tests do not require Sendblue credentials, hardware, ngrok, or
Messages.app access.

### Optional: live Redis smoke tests

Two integration suites are gated on `TEST_REDIS_URL` and skipped by
default:

- `tests/integration/limits-redis-store.test.ts` exercises the
  Lua-managed pacing slot, the Lua-atomic `INCR`+`EXPIRE` for time-window
  buckets, the `SADD`/`SCARD` distinct-inbound counters, the SMS-stall
  JSON round-trip (including the new `conversationKey` field), and the
  SCAN-based `listSmsLimitStalls` enumeration.
- `tests/integration/recovery.test.ts` exercises
  `ConversationAgent.recoverPendingRetries()`: directly persists a
  conversation in `'sending'` state with a `nextRetryAt`/`retryCount`
  and confirms the recovered timer fires; persists a stranded SMS
  stall and confirms recovery clears it; and confirms in-memory
  recovery is a no-op.

Opt in by pointing `TEST_REDIS_URL` at a Redis you do not mind being
`FLUSHDB`'d:

```bash
TEST_REDIS_URL=redis://localhost:6379/15 npm run test:integration
```

Both suites run `FLUSHDB` between cases, so use a non-default DB index
(`/15` above) to avoid clobbering app data on DB 0. Do not point this
at production Redis.

## Repo-Managed E2E Setup

Run:

```bash
npm run setup:e2e
```

This creates a gitignored `.env` file if one does not already exist. Fill in
Sendblue, native Messages, and ngrok values there.

Run:

```bash
npm run verify:e2e
```

This checks prerequisites without sending a real message:

- `NGROK_AUTHTOKEN` is present for the repo-managed ngrok SDK tunnel.
- The host is macOS and has `osascript` and `sqlite3`.
- `E2E_MESSAGES_DB_PATH` is readable, usually via Full Disk Access.
- Sendblue webhook API is reachable with the configured credentials.

Run:

```bash
npm run dev:e2e
```

This starts the local deterministic chat endpoint, an ngrok SDK tunnel, agent
server, and Sendblue webhook registration. It prints the public URL and webhook
actions so the setup can be inspected.

Run:

```bash
npm run sendblue:webhooks
```

This registers or updates the managed Sendblue `receive` and `outbound`
webhooks using the current `E2E_PUBLIC_BASE_URL`/`PUBLIC_BASE_URL`. Pass
`-- --all` to register every known Sendblue webhook type for a capture session:

```bash
npm run sendblue:webhooks -- --all
```

Run:

```bash
npm run capture:guided
```

This starts the capture server, opens an ngrok SDK tunnel unless
`E2E_PUBLIC_BASE_URL` is set, registers Sendblue webhooks, and sends guided
instructions to `E2E_TEST_DEVICE_NUMBER`. The prompts cover text, image/video
media, audio/file media, six tapback reactions, send effects, group messaging,
and SMS fallback. Complete each action on the device; the script advances when
the expected webhook arrives. Reply `skip` to the current instruction to move
past a scenario without capturing it. Guided capture registers all known
Sendblue webhook types, so operational callbacks are also saved if they occur
during the session. Captures are written with scenario metadata so they can be
redacted and promoted into stable fixtures.

Use `npm run capture:guided -- --list` to print scenario IDs without starting
the networked capture stack. Use `npm run capture:guided -- --only <ids>` with a
comma-separated scenario list for focused follow-up captures, for example:

```bash
npm run capture:guided -- --only tapback-custom-emoji,effect-balloons,group-message
```

Run:

```bash
npm run showcase:e2e
```

This starts a scenario-aware local chat endpoint, agent server, ngrok SDK
tunnel, and managed Sendblue webhooks. It sends guided prompts to
`E2E_TEST_DEVICE_NUMBER`; after each user action, the agent replies in iMessage
with what it understood and the script writes a local evidence summary.

The showcase covers direct text echo, rapid-message buffering, standard and
custom Tapback understanding, inbound media, optional outbound hosted media,
send effects, reply-intent fallback, XML tag parsing, best-effort mark-read API
calls, outbound typing refresh attempts, inbound typing webhook state, addressed
groups, and SMS fallback. Group, SMS, custom Tapback, inbound typing, and
outbound media are optional; reply `skip` to move past the current step.

Use `npm run showcase:e2e -- --list` to print scenario IDs, or
`npm run showcase:e2e -- --only basic-text,tapback-heart,read-typing` for a
focused run.

Optional showcase settings:

- `SHOWCASE_MEDIA_URL` - public HTTPS asset used by the outbound media step.
  If unset, that step replies that hosted media was skipped.
- `SHOWCASE_READ_TYPING_DELAY_MS` - chat endpoint delay for the
  read-receipt/typing step, default `15000`.
- `SHOWCASE_BUFFER_BASE_TIMEOUT_MS`, `SHOWCASE_BUFFER_GROWTH_FACTOR`,
  `SHOWCASE_BUFFER_MAX_TIMEOUT_MS`, and `SHOWCASE_BUFFER_NOISE_MAX_DEVIATION` -
  showcase-only buffer settings. They default to a deliberately longer and
  non-random quiet window than the normal agent runtime.
- `SHOWCASE_TYPING_REFRESH_INTERVAL_MS` and `SHOWCASE_TYPING_REFRESH_MAX_MS` -
  showcase-only outbound typing refresh settings for the dedicated typing step.

Showcase captures are written under `.captures/sendblue-showcase/<session>/`.
The directory includes raw webhook envelopes plus `summary.json` with receive,
status, outbound message, reaction, mark-read attempt/success/failure, outbound
typing attempt/success/failure, chat request buffering, and inbound typing
webhook counts for each step. Treat these artifacts like other captures: they may
contain secrets, phone numbers, tunnel URLs, and real message content.

The public Sendblue docs list `typing_indicator` as a webhook type, but some
live account webhook API responses reject `POST` registration for that type or
drop it from full `PUT` updates. The showcase therefore attempts to register
`typing_indicator`, verifies whether it persisted in the account webhook list,
and records the diagnostic in `summary.json`. If it cannot be registered, the
inbound typing step still runs but reports that no inbound typing state arrived
before the user's message.

Do not promote inbound typing to an observed E2E capability until
`summary.json` shows `typingWebhookRegistration.persisted: true` and at least
one `/webhook/typing-indicator` capture exists. Until then, typing indicator
coverage is split into outbound typing API attempts, which can be observed in
the Sendblue call instrumentation, and synthetic/local inbound route coverage.

## Real-Device E2E

Run:

```bash
npm run test:e2e
```

This suite starts its own ngrok SDK tunnel, registers Sendblue webhooks, sends a
real iMessage from Messages.app to the Sendblue number, and verifies the reply
in the local Messages database:

1. `osascript` sends a UUID-tagged iMessage to `SENDBLUE_FROM_NUMBER`.
2. Sendblue calls the generated ngrok URL at `/webhook/receive`.
3. The local deterministic chat endpoint replies with the same UUID.
4. The agent sends the response through Sendblue `send-message`.
5. Sendblue calls the generated ngrok URL at `/webhook/status`.
6. `sqlite3 -readonly` polls `E2E_MESSAGES_DB_PATH` for the reply from
   `SENDBLUE_FROM_NUMBER`.

Prerequisites:

- `.env` exists and has been filled in.
- The host is macOS and signed into Messages.app with iMessage enabled.
- Terminal or the test runner has Full Disk Access for `~/Library/Messages/chat.db`.
- `osascript` is allowed to control Messages.app when macOS prompts for Automation access.
- `NGROK_AUTHTOKEN` is set, unless `E2E_PUBLIC_BASE_URL` points to an externally managed tunnel.
- `SENDBLUE_FROM_NUMBER` is the dedicated Sendblue line used for replies.

`dev:e2e` handles ngrok startup and Sendblue webhook registration for local
development. Set `NGROK_DOMAIN` only if you want a reserved stable ngrok domain;
otherwise the generated URL is used and Sendblue webhooks are updated each run.
The one-time native host setup still requires macOS access: sign into
Messages.app, grant Full Disk Access to the terminal runner, and approve the
Messages Automation prompt for `osascript`.

The E2E test is intentionally not part of `npm test` because it sends real
messages and depends on external services.

## Rich Capability Scenarios

Rich action scenario placeholders live under `tests/e2e` so they run only when
`npm run test:e2e` is selected. Hardware-free placeholders should document the
expected sequence and safety gates before a scenario is promoted to live
Sendblue coverage.

Promote a scenario to real-device E2E only after confirming these expectations:

- Hosted media actions use an HTTPS `mediaUrl` that Sendblue can fetch and
  Messages.app can display.
- Send effects use `sendStyle` only on direct iMessage conversations and degrade
  to plain text on SMS or downgraded conversations.
- Reactions target a captured message identifier or documented Sendblue
  selector; missing targets must not send duplicate plain messages.
- Reply actions preserve chat-contract intent but currently degrade to normal
  Sendblue messages because Sendblue direct sends do not expose a native reply
  target parameter.
- Read receipts are best-effort `POST /api/mark-read` calls gated by
  `READ_RECEIPTS_ENABLED`; there is no `READ` status callback and on-device
  display must be manually verified on an enabled Sendblue account.
- Typing refreshes stop after response completion, SMS downgrade, interruption,
  or terminal delivery status.
- Group replies are sent only when the inbound group message is addressed to
  `AGENT_DISPLAY_NAME`, references a known agent outbound, or future payloads
  include explicit reply metadata for the agent.

Use `examples/action-catalog` as the deterministic chat endpoint when manually
exercising `actions[]` or XML tag compatibility in a rich-capable runtime.

## Captured Fixtures

Synthetic fixtures live in `tests/fixtures/sendblue`. Use:

```bash
npm run capture:fixtures
npm run capture:guided
```

`capture:fixtures` starts a local server on `E2E_AGENT_PORT` with:

- `POST /webhook/receive`
- `POST /webhook/status`
- `POST /webhook/typing-indicator`
- `POST /webhook/call-log`
- `POST /webhook/line-blocked`
- `POST /webhook/line-assigned`
- `POST /webhook/contact-created`

It writes request envelopes shaped as `{ headers, body, receivedAt, path }` to
`.captures/sendblue/`. That directory is gitignored and may contain raw phone
numbers, secrets, tunnel URLs, and real message content.

`capture:guided` writes the same envelope shape plus a `capture` metadata object
with the active capture session and scenario. Prefer this mode when collecting
rich payload fixtures because the filenames and metadata identify which manual
action produced each webhook.

After manual redaction, move stable captures to
`tests/fixtures/sendblue/captured/`. Captured envelope tests replay those
requests through the real Express handlers, so they cover webhook security,
parsing, status callbacks, downgrade fields, rich message fields, and groups at
the route boundary.

Observed rich-payload structures are documented in
`docs/SENDBLUE-PAYLOAD-STRUCTURES.md`.

Synthetic operational webhook fixtures live under
`tests/fixtures/sendblue/captured/operational/`. They prove route coverage for
`typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, and
`contact_created`; replace or supplement them with redacted observed captures
once those callbacks are collected from Sendblue.

For `typing_indicator`, first confirm that the account webhook API accepts and
persists the type. A successful full-webhook `PUT` alone is not enough; follow
up with `GET /api/account/webhooks` and verify the `typing_indicator` entry is
still present.

Before committing captured payloads, remove account emails, phone numbers,
message content from real people, credentials, webhook secrets, and tunnel URLs.
