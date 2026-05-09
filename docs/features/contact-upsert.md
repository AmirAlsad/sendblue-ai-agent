# Sendblue Contact Upsert

## What it does

When an inbound message arrives from a phone number that resolves to a known
user (via `IdentityResolver`), the agent upserts a Sendblue contact for that
number with the resolved name. The Sendblue dashboard then shows the user's
name instead of the raw E.164, and Sendblue analytics/segmentation surfaces
get populated automatically.

The feature is **default off** — set `SENDBLUE_CONTACTS_ENABLED=true` and have
your `USER_LOOKUP_URL` return at least one of `firstName` / `lastName` to opt
in.

## How it works

After dedupe, identity resolution, and the unauthorized-user check, the agent
fires a `POST /api/v2/contacts` call with `update_if_exists: true` for each
applicable phone number. The call runs **fire-and-forget**: failures are logged
and never block buffering or chat dispatch.

### Trigger rules

- **Direct inbound:** the from-number is upserted when the resolver returned a
  name. If `validUserRequired=true` and the identity is unauthorized, the
  inbound returns early before reaching this hook.
- **Group inbound (invoked & authorized only):** the from-number is upserted
  (same gate as direct), and every entry in `webhook.participants` is
  iterated sequentially. For each participant, the resolver runs again with
  the participant's number; if it returns a name, the participant is
  upserted. The configured line number and the speaker are skipped to avoid
  redundant calls. **Non-invoked group inbounds and unauthorized invokers
  do NOT trigger contact upserts** — the agent's `handleReceive` returns
  early on those branches (`agent.ts:149` for non-invoked, `agent.ts:174`
  for unauthorized) before the upsert hook fires, matching the broader
  "groups stay silent unless addressed" rule from `AGENTS.md`. If you want
  contact creation to fire on every group inbound regardless of invocation,
  that is a deliberate scope expansion — not the default.
- **Idempotency:** every upsert is a `POST` with `update_if_exists: true`.
  Sendblue's docs do not document the duplicate-POST behavior without that
  flag, so the helper always passes it. A per-(line, number) dedupe SETNX
  claim on the conversation store prevents the agent from re-burning the
  contacts API on every inbound — re-upsert only happens once the dedupe TTL
  expires (default 30 days). The dedupe TTL must be `>= 1` second; the
  config loader rejects `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS=0`.

### Request shape

```http
POST /api/v2/contacts
Host: api.sendblue.com
sb-api-key-id: ...
sb-api-secret-key: ...
Content-Type: application/json

{
  "number": "+15551110001",
  "first_name": "Ada",
  "last_name": "Lovelace",
  "sendblue_number": "+15552220000",
  "tags": ["agent", "tier:gold"],
  "custom_variables": { "plan": "agent" },
  "update_if_exists": true
}
```

`tags` are merged: `SENDBLUE_CONTACTS_DEFAULT_TAGS` from configuration + the
optional `tags` array from the resolver. Empty/whitespace entries are dropped
and the merged list is deduped.

### Live response shape (verified 2026-05-09)

`npm run probe:contacts` confirmed Sendblue's documented body shape against
a real account. The response wraps the contact under a `contact` key, with
the phone number under `phone` (not `number`):

```json
{
  "status": "OK",
  "contact": {
    "first_name": "Probe",
    "last_name": "Test",
    "phone": "+15551110001",
    "company_name": "<account default>",
    "tags": ["agent", "auto-delete"],
    "sendblue_number": "+15552220000",
    "created_at": "2026-05-09T00:00:00.000Z",
    "custom_variables": { "source": "..." },
    "firstName": "Probe",
    "lastName": "Test",
    "companyName": "<account default>",
    "sendblueNumber": "+15552220000",
    "customVariables": { "source": "..." }
  }
}
```

Sendblue echoes both `snake_case` and `camelCase` variants of every field
plus a `company_name` derived from the account. `HttpSendblueClient.createContact`
reads the phone from `contact.phone` (with `contact.number` as a
forward-compat fallback) and otherwise hands the full body back on `result.raw`.

## Code files

| File | Role |
| --- | --- |
| `src/sendblue/contacts.ts` | Pure helpers (`buildContactBody`, `upsertContactFromIdentity`) |
| `src/sendblue/client.ts` | `createContact()` HTTP method |
| `src/sendblue/types.ts` | `SendblueContactRequest` / `SendblueContactResult` |
| `src/conversation/agent.ts` | `upsertContactsForReceive` orchestration in `handleReceive` |
| `src/conversation/store.ts` | `claimContactUpsert` SETNX-with-TTL dedupe |
| `src/conversation/redis-store.ts` | Redis-backed dedupe key (`sendblue-ai-agent:contact-upserted:*`) |
| `src/identity/resolver.ts` | `firstName`, `lastName`, `tags`, `customVariables` widening |

## Configuration

- `SENDBLUE_CONTACTS_ENABLED` — default `false`. Set to `true` once your
  `USER_LOOKUP_URL` returns name fields.
- `SENDBLUE_CONTACTS_DEFAULT_TAGS` — comma-separated. Applied to every contact.
- `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS` — default `2592000` (30 days).

## Known limitations

- Sendblue does not document the duplicate-POST behavior without
  `update_if_exists`; we always pass the flag, plus the local dedupe SETNX,
  so the agent never tries the un-flagged path.
- Sendblue's `contact_created` webhook is registered as an operational event
  but its payload schema is undocumented; the agent treats it as opaque.
- The dedupe TTL means name changes can take up to `SENDBLUE_CONTACTS_DEDUPE_TTL_SECONDS`
  to propagate. Lower the TTL or manually update the contact in the Sendblue
  dashboard if you need faster propagation.
- The bulk endpoint (`POST /api/v2/contacts/bulk`) is intentionally not used —
  per-participant upserts are sequential to keep single-flight semantics. With
  large groups (10+ participants) the first inbound can be slow, but the
  dedupe set short-circuits subsequent inbounds.
- Group participants are upserted **only on invoked & authorized group
  inbound**. Non-invoked groups and unauthorized invokers (when
  `VALID_USER_REQUIRED=true`) do not trigger the contacts API. This
  matches the broader `AGENTS.md` "groups stay silent unless addressed"
  rule: if the agent isn't going to reply, it shouldn't be quietly
  enriching Sendblue's contact list either.
- Tag dedup is **case-insensitive** — `'Agent'` and `'agent'` collapse to
  the first occurrence's casing in the merged list. Avoids visible
  duplicates in the Sendblue dashboard when default and identity tags
  differ on case.
- Backfill is not supported in v1 — contacts only get created as new inbound
  arrives. There is no script that walks the existing conversation store and
  upserts every known number.
