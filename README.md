# sendblue-ai-agent

Messaging infrastructure for deploying an AI agent over iMessage with Sendblue.

This package is intentionally transport and orchestration focused. The developer
brings a chat endpoint; this package handles Sendblue webhook ingestion, outbound
delivery, status tracking, deduplication, and later conversation intelligence.

## Current Foundation

The root package is scaffolded as TypeScript ESM with Vitest test infrastructure:

```bash
npm test
npm run setup:e2e
npm run verify:e2e
npm run dev:e2e
npm run capture:fixtures
npm run test:e2e
npm run typecheck
```

`npm test` runs hardware-free unit and integration tests. The repo owns the
E2E orchestration scripts, but `npm run test:e2e` still requires a real Sendblue
line, Messages.app on macOS, read access to `~/Library/Messages/chat.db`, and
an ngrok tunnel.

## Environment

Copy `.env.example` to `.env` and set the values for local development.

Required for the agent:

- `PUBLIC_BASE_URL`
- `CHAT_ENDPOINT_URL`
- `SENDBLUE_API_KEY_ID`
- `SENDBLUE_API_SECRET_KEY`
- `SENDBLUE_FROM_NUMBER`

Optional until confirmed from a real captured webhook:

- `SENDBLUE_WEBHOOK_SECRET`
- `SENDBLUE_WEBHOOK_SECRET_HEADER`

Required only for E2E:

- `E2E_AGENT_PORT`
- `E2E_PUBLIC_BASE_URL`
- `E2E_SENDBLUE_NUMBER`
- `E2E_TEST_DEVICE_NUMBER`
- `E2E_MESSAGES_DB_PATH` (optional, defaults to `~/Library/Messages/chat.db`)
- `NGROK_AUTHTOKEN`
- `NGROK_BIN`
- `NGROK_API_URL`

Run `npm run setup:e2e` to create a local gitignored `.env.e2e` file. The repo
scripts load `.env` and `.env.e2e`, with real-device settings kept in
`.env.e2e`.

## Webhooks

`npm run sendblue:webhooks` configures Sendblue to call:

- `POST {PUBLIC_BASE_URL}/webhook/receive`
- `POST {PUBLIC_BASE_URL}/webhook/status`

The current webhook secret header name is configurable because Sendblue's
published docs do not pin a single header name. Capture one real webhook before
enforcing this in production.

## Repo-Managed E2E

Use:

```bash
npm run setup:e2e
npm run verify:e2e
npm run dev:e2e
npm run capture:fixtures
```

`setup:e2e` creates `.env.e2e`. `verify:e2e` checks ngrok, native macOS
Messages prerequisites, and Sendblue API reachability without sending messages.
`dev:e2e` starts the local agent, deterministic chat endpoint, ngrok tunnel, and
registers Sendblue webhooks.

`capture:fixtures` starts a minimal local capture server for
`/webhook/receive` and `/webhook/status` and writes raw request envelopes to
`.captures/sendblue/`. Redact captures manually before moving stable examples
into `tests/fixtures/sendblue/captured/`.

The repo cannot grant macOS Full Disk Access, sign into Messages.app, approve
Automation prompts, or configure Sendblue/ngrok account settings. Those one-time
host/account permissions still need to be completed on the Mac.
