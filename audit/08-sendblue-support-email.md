# Sendblue support email — verification and revisions

## Verdict

Your draft is factually accurate. All five substantive claims check out against current Sendblue docs, and the captured 400 response is reproducible (3 separate showcase sessions today, both `api.sendblue.co` and `api.sendblue.com` base URLs).

## What I verified

| Claim | Status | Source |
| --- | --- | --- |
| `typing_indicator` is a documented webhook type with payload fields `number`, `is_typing`, `from_number`, `timestamp` | ✅ verbatim match | https://docs.sendblue.com/api-v2/typing-indicators |
| The general Webhooks page lists `typing_indicator` alongside the other 6 types | ✅ verbatim match | https://docs.sendblue.com/getting-started/webhooks |
| `POST /api/account/webhooks` returns 400 "Invalid webhook type. Must be one of: receive, call_log, line_blocked, line_assigned, outbound, contact_created" | ✅ exact match | `.captures/sendblue-showcase/0d73fdf0/summary.json` (today, both base hosts) |
| `PUT /api/account/webhooks` returns 200 "Webhooks updated successfully" but doesn't persist `typing_indicator` on subsequent GET | ✅ exact match | same capture |
| Outbound `/api/send-typing-indicator` works | ✅ documented + verified | https://docs.sendblue.com/api-v2/typing-indicators |

## Suggested improvements to the draft

1. **Cite the dedicated typing-indicator page**, not just the general webhooks page. The strongest evidence is at `https://docs.sendblue.com/api-v2/typing-indicators` — that page documents the inbound webhook payload fields you mention. Linking it makes the docs/API contradiction harder to dismiss.
2. **Pre-empt the "iMessage-only constraint" reply.** Their docs say "Typing indicators are only supported for iMessage conversations, not SMS or RCS." Acknowledge it explicitly in your testing context paragraph so they can't say "works as designed; your test wasn't iMessage."
3. **Mention both base URLs failed identically.** We have captures showing the same 400 from both `https://api.sendblue.co` and `https://api.sendblue.com` — proves it's not a wrong-host issue.
4. **Note the silent-drop on PUT is the more concerning bug** — POST returning 400 is at least loud; PUT returning 200 with silent state drop is the kind of thing that breaks IaC/idempotent reconcilers. Worth calling out separately.
5. **Ask a specific question.** Instead of "is this gated?", ask "is the registration shape different for `typing_indicator` (e.g. a separate endpoint, an account-level flag, or a different request body)?" — gives them a concrete answer space.
6. Tiny typo in your draft: "the full whook configuration" → "the full webhook configuration".

## Revised draft

```
Subject: Inbound typing_indicator webhook registration rejected/silently dropped

Hi Sendblue team,

I'm trying to enable inbound typing_indicator webhooks for our account/line,
but the webhook registration API rejects the documented type on POST and
silently drops it on PUT, even though Sendblue's docs list it as a supported
inbound webhook with a specified payload schema.

Docs we're working from:

- https://docs.sendblue.com/api-v2/typing-indicators — documents the inbound
  payload fields (`number`, `is_typing`, `from_number`, `timestamp`) and says
  the typing-indicator webhook is configured via
  `POST https://api.sendblue.com/api/account/webhooks` with
  `type: "typing_indicator"`.
- https://docs.sendblue.com/getting-started/webhooks — lists typing_indicator
  alongside `receive`, `outbound`, `call_log`, `line_blocked`,
  `line_assigned`, and `contact_created`.

Observed behavior (reproduced today against both api.sendblue.co and
api.sendblue.com from a dedicated Sendblue line):

1) POST registration is rejected.

   Request:
       POST https://api.sendblue.com/api/account/webhooks
       sb-api-key-id: ***
       sb-api-secret-key: ***
       Content-Type: application/json

       { "type": "typing_indicator",
         "webhooks": ["https://our-public-url.example/webhook/typing-indicator"] }

   Response: 400
       { "status": "ERROR",
         "message": "Invalid webhook type. Must be one of: receive,
                     call_log, line_blocked, line_assigned, outbound,
                     contact_created" }

   The error message omits typing_indicator from the allowed list, contradicting
   the docs above.

2) PUT replacement reports success but silently drops typing_indicator.

   Request:
       PUT https://api.sendblue.com/api/account/webhooks
       Content-Type: application/json

       { "webhooks": {
           "typing_indicator": ["https://our-public-url.example/webhook/typing-indicator"],
           ... existing entries ...
       }}

   Response: 200 { "status": "OK", "message": "Webhooks updated successfully" }

   But an immediate `GET /api/account/webhooks` returns the previous config
   without the typing_indicator entry. Same behavior on both hosts.

For context:
- Outbound typing indicators via `/api/send-typing-indicator` work as
  documented (200 with status QUEUED).
- We understand from the docs that typing indicators are iMessage-only and
  are testing on a dedicated line over real iMessage traffic.
- The issue is specifically registering and receiving inbound
  `typing_indicator` webhooks — there's no observable path for them to
  reach our endpoint.

Could you confirm whether inbound `typing_indicator` webhook registration
is currently gated on our account/line, and either enable it or share the
correct registration shape (separate endpoint, account-level flag, different
request body, etc.)? If the API rejection is a bug we should treat as
permanent, we'll plan around it; if it's an account-level toggle, please
flip it.

Thanks!
Amir Alsad
```

## Read-receipt re-test result (separate finding)

Wrote `scripts/e2e/probe-sendblue.ts` (added `npm run probe:sendblue`) that
calls `/api/mark-read` and prints the response. Ran it against your account.

**Result:** `400 — "You must specify a valid 'from_number' in the request body."`

**Diagnosis:** your `.env` has a double-plus typo:

```
SENDBLUE_FROM_NUMBER=++16094332541
```

It should be `+16094332541`. Sendblue's captured webhooks confirm your line
is registered as the single-`+` form. Once support enabled the read-receipt
feature (which they did), the call started getting *past* the account gate
and into request validation, which is when the typo surfaced.

**Action:** edit `.env` to `SENDBLUE_FROM_NUMBER=+16094332541`, then re-run:

```bash
npm run probe:sendblue
```

You should see `SUCCESS` with response `{ "status": "OK", "message": "Mark read request sent", "number": "+17866305482" }` per Sendblue's documented success shape.

## Follow-up worth considering

`loadConfig` in `src/config/env.ts` accepts `SENDBLUE_FROM_NUMBER` raw — no
E.164 validation. The typo above would have been caught at startup with a
clear error if we validated. Cheap to add (`/^\+\d{10,15}$/`) and would
prevent this exact silent failure mode for the next person who edits .env.
Not in scope for this audit; flagging.
