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

This creates a gitignored `.env.e2e` file with the variables used by the
repo-managed E2E tooling. Fill in Sendblue, native Messages, and ngrok values there.

Run:

```bash
npm run verify:e2e
```

This checks prerequisites without sending a real message:

- ngrok CLI is installed and runnable.
- The host is macOS and has `osascript` and `sqlite3`.
- `E2E_MESSAGES_DB_PATH` is readable, usually via Full Disk Access.
- Sendblue webhook API is reachable with the configured credentials.

Run:

```bash
npm run dev:e2e
```

This starts the local deterministic chat endpoint, ngrok tunnel, agent server,
and Sendblue webhook registration. It prints the public URL and webhook actions
so the setup can be inspected.

Run:

```bash
npm run sendblue:webhooks
```

This registers or updates the managed Sendblue `receive` and `outbound`
webhooks using the current `E2E_PUBLIC_BASE_URL`/`PUBLIC_BASE_URL`.

## Real-Device E2E

Run:

```bash
npm run test:e2e
```

This suite sends a real iMessage from Messages.app to the Sendblue number and
verifies the reply in the local Messages database:

1. `osascript` sends a UUID-tagged iMessage to `E2E_SENDBLUE_NUMBER`.
2. Sendblue calls `{E2E_PUBLIC_BASE_URL}/webhook/receive`.
3. The local deterministic chat endpoint replies with the same UUID.
4. The agent sends the response through Sendblue `send-message`.
5. Sendblue calls `{E2E_PUBLIC_BASE_URL}/webhook/status`.
6. `sqlite3 -readonly` polls `E2E_MESSAGES_DB_PATH` for the reply from
   `E2E_SENDBLUE_NUMBER`.

Prerequisites:

- `.env.e2e` exists and has been filled in.
- The host is macOS and signed into Messages.app with iMessage enabled.
- Terminal or the test runner has Full Disk Access for `~/Library/Messages/chat.db`.
- `osascript` is allowed to control Messages.app when macOS prompts for Automation access.
- ngrok routes `E2E_PUBLIC_BASE_URL` to `E2E_AGENT_PORT` on this machine.
- Sendblue webhooks point to:
  - `{E2E_PUBLIC_BASE_URL}/webhook/receive`
  - `{E2E_PUBLIC_BASE_URL}/webhook/status`
- `SENDBLUE_FROM_NUMBER` is the dedicated Sendblue line used for replies.

`dev:e2e` handles ngrok startup and Sendblue webhook registration for local
development. The one-time native host setup still requires macOS access: sign
into Messages.app, grant Full Disk Access to the terminal runner, and approve
the Messages Automation prompt for `osascript`.

The E2E test is intentionally not part of `npm test` because it sends real
messages and depends on external services.

## Captured Fixtures

Synthetic fixtures live in `tests/fixtures/sendblue`. Use:

```bash
npm run capture:fixtures
```

This starts a local server on `E2E_AGENT_PORT` with:

- `POST /webhook/receive`
- `POST /webhook/status`

It writes request envelopes shaped as `{ headers, body, receivedAt, path }` to
`.captures/sendblue/`. That directory is gitignored and may contain raw phone
numbers, secrets, tunnel URLs, and real message content.

After manual redaction, move stable captures to
`tests/fixtures/sendblue/captured/`. Captured envelope tests replay those
requests through the real Express handlers, so they cover webhook security,
parsing, status callbacks, downgrade fields, rich message fields, and groups at
the route boundary.

Before committing captured payloads, remove account emails, phone numbers,
message content from real people, credentials, webhook secrets, and tunnel URLs.
