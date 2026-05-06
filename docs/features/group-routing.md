# Group Routing

## What it does

Handles inbound Sendblue group webhooks, decides whether the agent
should respond, and sends outbound group replies via
`/api/send-group-message`. Critically, **group receives are silent
unless the agent is explicitly addressed** — the agent never inserts
itself into ongoing group conversations.

This is a load-bearing rule per AGENTS.md: an unaddressed group
message is acknowledged, deduped, and logged, but no chat-endpoint call
or outbound send happens.

## How it works

### Conversation key

`group:{sendblueLine}:{groupId}` — one record per Sendblue line per
group, regardless of which participant sent the inbound. All other
load-bearing rules (one record across services, no per-participant
records) carry over from direct conversations
(`docs/features/conversation-state.md`).

### Invocation gate

`ConversationAgent.isInvokedGroupWebhook` decides whether a group
inbound counts as addressing the agent. Three signals, in order of
strength:

1. **`@AGENT_DISPLAY_NAME` mention.** The default name is `sb-agent`;
   override via env. The match is case-sensitive on the name itself but
   tolerates leading `@` and surrounding word-boundary punctuation.
2. **Reply / Tapback metadata referencing a known agent outbound.**
   `referencedMessageHandles(payload.raw)` heuristically scans the raw
   webhook payload for any string keyed `*message_handle*`, `*reply_to*`,
   `*reacted_to*`, or `*target*`. If any of those handles maps to an
   outbound the agent owns on this conversation, the inbound is
   addressed. This is forward-compatible with future Sendblue payload
   fields — they are picked up automatically.
3. **(Soft, gated) Substring match against a prior agent message.**
   When `GROUP_INVOCATION_CONTENT_FALLBACK=on` (default), a group
   message that contains a previously delivered agent message as a
   substring counts as addressed. Disabled by default in production?
   No — the legacy default is `on` for backward compatibility, but the
   heuristic is brittle (agent sent `"yes"` → user later writes
   `"yes please"` invokes the agent). Set to `off` to require explicit
   addressing only.

### Outbound

Group replies go through `SendblueClient.sendGroupMessage` which calls
`POST /api/send-group-message`. Each send carries its own
`status_callback` URL so ordered-delivery advancement on the group
queue works the same as direct queues. iMessage-only rich actions
(send effects, reactions, replies, typing refreshes) are gated by the
conversation channel, not by group-vs-direct — Sendblue group messages
support `send_style` on iMessage but typing indicators are not sent
into groups.

Replies sent into a group reference the conversation by `group_id`
only; Sendblue does not currently expose a native reply-target
parameter for direct or group sends, so contextual replies are
preserved as intent in the chat contract but sent as plain messages.

## Code files

| File | Role |
| --- | --- |
| `src/conversation/agent.ts:isInvokedGroupWebhook` | Three-signal invocation gate |
| `src/conversation/agent.ts:applyGroupMetadata` | Captures `groupId`, `groupDisplayName`, `participants` from inbound |
| `src/conversation/agent.ts:mentionsAgent` | Display-name match with word-boundary tolerance |
| `src/conversation/agent.ts:referencedMessageHandles` | Heuristic scan of payload for reply/tapback target handles |
| `src/sendblue/client.ts:sendGroupMessage` | `POST /api/send-group-message` |
| `src/sendblue/parser.ts:parseReceiveWebhook` | Surfaces `groupId`, `groupDisplayName`, `participants` |

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `AGENT_DISPLAY_NAME` | `sb-agent` | Name participants use to address the agent in group threads. |
| `GROUP_INVOCATION_CONTENT_FALLBACK` | `true` | When `false`, the substring-of-prior-agent-message heuristic is disabled — only mentions and reply metadata count as addressing. Set to `false` to avoid false-positive invocation on short prior replies. |

## Known limitations

- **Display-name mentions are case-sensitive on the configured name** but
  tolerate word-boundary punctuation. `@sb-agent`, `sb-agent:`,
  `sb-agent.` all match; `SB-Agent` does not. Choose a display name
  that participants will type consistently.
- The substring-of-prior-agent-message fallback is fragile. Short replies
  cause false positives (see `GROUP_INVOCATION_CONTENT_FALLBACK`).
- **No native reply-target on outbound group sends.** The chat contract
  preserves `reply` action intent end-to-end, but the actual
  `send-group-message` call has no `reply_to_message_handle` parameter
  in the documented Sendblue API today. Replies render as plain
  messages in the group.
- `mentionsAgent` requires a leading word boundary. A name pasted after
  a non-space character like `>sb-agent` (quoted) does not match.
  Acceptable for typical usage; surfaces as a missed invocation in
  unusual quoting flows.
- **Group identity is per-invoker, not per-group.** When the optional
  identity resolver runs on a group inbound, it resolves the invoking
  participant's phone number, not the group as a whole. The
  conversation key is `group:{line}:{groupId}` regardless.
- Group send accepts `send_style` per Sendblue docs; reactions and
  typing indicators are not sent into groups.
