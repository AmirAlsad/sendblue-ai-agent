# Sendblue Payload Structures

These notes summarize redacted real webhook captures collected with
`npm run capture:guided`. The stable fixtures live in
`tests/fixtures/sendblue/captured/observed/`.

Raw captures in `.captures/sendblue/` may contain phone numbers, account data,
secrets, tunnel URLs, and real content. Do not commit raw captures.

## Common Receive Shape

Observed `receive` webhooks shared this body shape:

- `accountEmail`
- `content`
- `is_outbound`
- `status`
- `error_code`
- `error_message`
- `error_reason`
- `message_handle`
- `date_sent`
- `date_updated`
- `from_number`
- `number`
- `to_number`
- `was_downgraded`
- `plan`
- `media_url`
- `message_type`
- `group_id`
- `participants`
- `send_style`
- `opted_out`
- `error_detail`
- `sendblue_number`
- `service`
- `group_display_name`

Observed receive requests used the `sb-signing-secret` header when a webhook
secret was configured.

`receive` payloads may use `status: "RECEIVED"`. This is distinct from
outbound status callbacks, where `RECEIVED` is not a valid lifecycle status.

## Media

Image, video, and audio/file captures all arrived as ordinary inbound messages:

- `message_type: "message"`
- `service: "iMessage"`
- `media_url`: populated
- `send_style: ""`
- no observed MIME type or media category field

The observed inbound media URLs were hosted on `storage.googleapis.com`. The
redacted fixtures preserve the URL host and use fake object paths.

## Tapbacks

Classic and custom Tapbacks arrived as ordinary inbound messages:

- `message_type: "message"`
- `service: "iMessage"`
- `media_url: ""`
- `send_style: ""`
- no observed `reaction_type`
- no observed `referenced_message_handle`

The Tapback type was only visible in `content`.

Observed content patterns:

- Heart: `Loved "..."`
- Thumbs up: `Liked "..."`
- Thumbs down: `Disliked "..."`
- Haha: `Laughed at "..."`
- Emphasis: `Emphasized "..."`
- Question: `Questioned "..."`
- Custom emoji: `Reacted <emoji> to "..."`

Because Sendblue does not expose a structured referenced message handle in the
observed payloads, reaction support should treat Tapbacks as best-effort parsed
message content unless future captures show richer fields.

## Inbound Send Effects

Messages sent with iMessage effects arrived as plain receive payloads:

- `message_type: "message"`
- `service: "iMessage"`
- `send_style: ""`

The outbound API supports `send_style`, but the observed inbound effect captures
did not preserve the sender's effect in that field.

For outbound rich actions, treat `sendStyle` as an iMessage-only hint. Real
device E2E should verify every style before documenting it as supported by this
package.

## Groups

Observed group messages were distinguishable by:

- `message_type: "group"`
- `group_id`: populated
- `participants`: populated array
- `group_display_name: ""`

The group display name was empty in the observed capture. Use `group_id` as the
stable correlation field and treat display name as optional.

Group receives should stay silent unless addressed group routing is enabled.
When routed, preserve `group_id`, `participants`, and `group_display_name` in
the chat request so the endpoint can decide whether to answer.

## SMS-Originated Messages

The SMS capture was sent as SMS from the start, not as a failed iMessage
downgrade. Its observed shape was:

- `service: "SMS"`
- `was_downgraded: null`
- `message_type: "message"`

Runtime channel detection should therefore treat `service: "SMS"` as SMS even
when `was_downgraded` is not `true`.

Rich actions that depend on iMessage behavior should be suppressed for this
shape: reactions, replies, read receipts, typing refreshes, and send effects.

## Operational Webhook Types

The test harness has route coverage for these Sendblue webhook types:

- `typing_indicator`: `/webhook/typing-indicator`
- `call_log`: `/webhook/call-log`
- `line_blocked`: `/webhook/line-blocked`
- `line_assigned`: `/webhook/line-assigned`
- `contact_created`: `/webhook/contact-created`

Current fixtures for these are synthetic route fixtures under
`tests/fixtures/sendblue/captured/operational/`, not observed Sendblue payload
contracts. They preserve unknown fields through the generic operational parser
and should be replaced or supplemented when real callbacks are captured.

`typing_indicator` requires special caution: Sendblue's public docs list it as
an inbound webhook type, and the local route/parser are implemented, but live
webhook registration has been observed rejecting `type: "typing_indicator"` and
dropping it from full webhook updates. Treat inbound typing payload shape as
unconfirmed until a real callback is captured from an account where
registration persists.

## Focused Captures

Use the guided capture selector to investigate a specific payload without
rerunning the full scenario set:

```bash
npm run capture:guided -- --list
npm run capture:guided -- --only tapback-custom-emoji
npm run capture:guided -- --only tapback-custom-emoji,effect-balloons,group-message
```

The capture writer includes a per-process sequence number in each filename to
avoid collisions when Sendblue posts multiple callbacks in the same millisecond.
