# Testing Infrastructure

## Unit and Integration Tests

Run:

```bash
npm test
```

This runs:

- `tests/unit`: parser, config, status, chat contract, and Sendblue client tests.
- `tests/integration`: real Express app flow with injected fake chat and Sendblue clients.

These tests do not require Sendblue credentials, hardware, ngrok, or
Messages.app access.

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

Before committing captured payloads, remove account emails, phone numbers,
message content from real people, credentials, webhook secrets, and tunnel URLs.
