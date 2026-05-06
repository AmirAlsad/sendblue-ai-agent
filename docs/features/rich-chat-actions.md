# Rich Chat Actions

## What it does

Defines the forward-compatible chat endpoint response contract for rich
Sendblue capabilities: multi-message replies, hosted media, iMessage send
effects, reactions, contextual replies, silence, and addressed group routing.
Read receipts and typing refreshes are agent behaviors around the chat request
and outbound queue, not chat endpoint action types.

The legacy v0.2 response forms remain valid:

```json
{ "message": "single reply" }
```

```json
{ "messages": ["first reply", "second reply"] }
```

```json
{ "silence": true }
```

New integrations should prefer `actions[]` when they need anything beyond plain
ordered text. The agent should normalize legacy `message` and `messages`
responses into message actions internally, while treating `silence` as an
explicit no-op.

## Chat response shape

```json
{
  "actions": [
    {
      "type": "message",
      "content": "Here is the photo.",
      "mediaUrl": "https://cdn.example.com/photos/order-123.png",
      "sendStyle": "celebration"
    },
    {
      "type": "reaction",
      "reaction": "love",
      "target": { "alias": "latest" }
    },
    {
      "type": "reply",
      "content": "Replying to your last message.",
      "target": { "messageHandle": "recv-123" }
    }
  ]
}
```

Supported action types:

| Type | Purpose |
| --- | --- |
| `message` | Send a text and/or hosted-media message through Sendblue. |
| `media` | Send hosted media, optionally with a caption. |
| `reaction` | Send a Tapback-style reaction to a previous message when Sendblue exposes a usable target. |
| `reply` | Preserve contextual reply intent and send as a normal message until Sendblue exposes native replies. |
| `silence` | Acknowledge intentionally without calling Sendblue. |

Message actions use these fields:

- `content` - outbound message body. Empty content is valid only when `mediaUrl` is
  present.
- `mediaUrl` - HTTPS URL for media already hosted by the application.
- `sendStyle` - iMessage send effect such as `balloons`, `celebration`, or
  another Sendblue-supported style.
- `target` - optional target selector for replies/reactions/read receipts.
  Message handles are preferred; aliases and content matching are convenience
  selectors.

The agent remains responsible for Sendblue transport details such as
`from_number`, `status_callback`, ordered delivery, SMS downgrade suppression,
and direct-vs-group routing. Chat endpoints should not construct Sendblue API
payloads directly.

## XML tag compatibility

Some model providers are easier to steer with XML-like response tags than with a
strict JSON tool contract. When XML compatibility is enabled, the chat endpoint
may return a top-level `message` string containing Sendblue tags. The agent
should parse the tags into the same `actions[]` representation before delivery.

Example with default tag names:

```xml
<message>First reply.</message>
<message send_style="balloons">Second reply with an effect.</message>
<message media_url="https://cdn.example.com/demo.png">Hosted media caption.</message>
<reaction type="love" target="latest" />
<reply target="latest"><message>Replying directly to that message.</message></reply>
<no_response />
```

Compatibility tags should be treated as transport hints, not user-visible
formatting. Unknown tags should be ignored or logged, and malformed rich tags
should fail closed to plain text rather than causing duplicate sends.

## Groups

Group receives stay silent unless the message is addressed to the agent.
Addressing is based on `AGENT_DISPLAY_NAME`, best-effort references to known
agent outbound messages, or future explicit reply metadata.

When an addressed group message is routed to the chat endpoint, the request
should preserve group metadata:

```json
{
  "conversation": {
    "type": "group",
    "key": "group:+15552220000:observed-group-001",
    "groupId": "observed-group-001",
    "lineNumber": "+15552220000"
  },
  "sendblue": {
    "groupId": "observed-group-001",
    "participants": ["+15550000001", "+15550000002"]
  }
}
```

The chat endpoint can reply with ordinary actions. The agent should route those
actions back to the group only for addressed group turns. Unaddressed group
messages remain acknowledged, deduped, metadata-preserved, and silent.

## Configuration

Rich capability rollout knobs:

- `CHAT_RESPONSE_PARSE_TAGS` - parses XML-style tags in legacy string responses,
  default `true`.
- `CHAT_RESPONSE_MESSAGE_TAG`, `CHAT_RESPONSE_NO_RESPONSE_TAG`,
  `CHAT_RESPONSE_REACTION_TAG`, and `CHAT_RESPONSE_REPLY_TAG` - configurable tag
  names for the compatibility parser.
- `READ_RECEIPTS_ENABLED` - allows direct iMessage/RCS read receipts when
  Sendblue support is confirmed, default `false`.
- `READ_RECEIPT_DEBOUNCE_MS` - debounce before read receipt send, default `250`.
- `TYPING_REFRESH_INTERVAL_MS` - interval for repeated typing refreshes during
  long-running responses, default `5000`.
- `TYPING_REFRESH_MAX_MS` - maximum typing refresh duration, default `120000`.
- `AGENT_DISPLAY_NAME` - group mention name, default `sb-agent`.
- `VALID_USER_REQUIRED` - silently acknowledges null or unauthorized identities,
  default `false`.

## E2E expectations

Hardware-free tests should cover response normalization, XML parsing, downgrade
suppression, and routing decisions. Real-device E2E remains necessary for
Sendblue behavior that cannot be simulated locally:

- Hosted media is reachable by Sendblue and delivered to Messages.app.
- `sendStyle` produces the intended iMessage effect or degrades safely.
- Tapback/reaction and reply targets work with captured Sendblue identifiers.
- Read receipts are supported before `READ_RECEIPTS_ENABLED` is used
  in production.
- Typing refreshes do not continue after a terminal response or SMS downgrade.
- Addressed group replies route only to the intended `group_id`.

## Known limitations

- Observed inbound Tapbacks do not currently include structured reaction target
  handles; reaction support is best effort until real captures show stable
  target fields.
- Inbound send effects were not preserved in observed Sendblue receive payloads.
- SMS and downgraded conversations must suppress iMessage-only actions such as
  effects, reactions, read receipts, and typing refreshes unless Sendblue
  documents a safe fallback.
