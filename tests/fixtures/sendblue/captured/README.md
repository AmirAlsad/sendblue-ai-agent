# Captured Sendblue Payloads

Store redacted real Sendblue webhook request envelopes here as JSON files.
Use `npm run capture:fixtures` or `npm run capture:guided` to write raw local
captures to `.captures/sendblue/`, then redact and move stable examples into
this directory.

Before committing captures, remove or replace:

- account email
- phone numbers
- Sendblue credentials or webhook secrets
- public tunnel URLs
- message content that came from a real person

Keep the original field names and null/empty-string behavior intact. The point
of this directory is to preserve real Sendblue payload shape, not real user data.

The `observed/` directory contains redacted receive envelopes from guided rich
payload captures. See `docs/SENDBLUE-PAYLOAD-STRUCTURES.md` for the observed
message, media, Tapback, effect, group, and SMS shapes.

The `operational/` directory contains synthetic route fixtures for Sendblue
webhook types that have not yet been observed in real captures:
`typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, and
`contact_created`. Replace or supplement those files with redacted observed
payloads once the callbacks are captured.

`typing_indicator` is especially important to keep synthetic until proven:
Sendblue's public docs list the type, but live webhook registration may reject
or fail to persist it for an account. Only move it into observed fixture status
after a redacted real `/webhook/typing-indicator` envelope is captured.

The committed envelope shape is:

```json
{ "headers": {}, "body": {}, "receivedAt": "2026-05-05T00:00:00.000Z", "path": "/webhook/receive" }
```
