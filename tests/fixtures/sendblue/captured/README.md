# Captured Sendblue Payloads

Store redacted real Sendblue webhook request envelopes here as JSON files.
Use `npm run capture:fixtures` to write raw local captures to
`.captures/sendblue/`, then redact and move stable examples into this directory.

Before committing captures, remove or replace:

- account email
- phone numbers
- Sendblue credentials or webhook secrets
- public tunnel URLs
- message content that came from a real person

Keep the original field names and null/empty-string behavior intact. The point
of this directory is to preserve real Sendblue payload shape, not real user data.
The committed envelope shape is:

```json
{ "headers": {}, "body": {}, "receivedAt": "2026-05-05T00:00:00.000Z", "path": "/webhook/receive" }
```
