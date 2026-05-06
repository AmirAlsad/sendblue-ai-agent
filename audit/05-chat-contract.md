# Slice 5: Chat Contract & Rich Actions Audit

## Summary

Verified the chat-contract surface against Sendblue's live docs (send-message, reactions, mark-read, typing-indicators, API v2 overview). The action union, send-style enum, and reaction enum all match Sendblue's canonical values. Found and removed dead code in `actions.ts`, expanded the `TargetRef.alias` type to include the spellings the resolver actually accepts, added JSDoc and an `IMESSAGE_ONLY_ACTION_TYPES` constant, broadened test coverage (HttpChatClient request shape, error mapping, every send_style/reaction round-trip, edge cases in normalization and target resolution), and updated `docs/features/rich-chat-actions.md` to enumerate every Sendblue value with source URLs. No public-shape changes to the chat contract — all edits are additive or comment-only.

## iMessage Feature Coverage Table

| Sendblue feature | Our action type | Enum values match? | Degraded for SMS / RCS / downgraded? |
| --- | --- | --- | --- |
| Plain text send (`POST /api/send-message`) | `message` | n/a | ok on all channels |
| Hosted media (`media_url` on `send-message`) | `media`, or `message` with `mediaUrl` | n/a | ok on all channels (Sendblue degrades MMS via SMS) |
| Send effects (`send_style` on `send-message`) | `sendStyle` field on `message`/`media`/`reply` | yes — all 13 (`celebration`, `shooting_star`, `fireworks`, `lasers`, `love`, `confetti`, `balloons`, `spotlight`, `echo`, `invisible`, `gentle`, `loud`, `slam`) match `SENDBLUE_SEND_STYLES` and the [send-message reference](https://docs.sendblue.com/api/resources/messages/methods/send/) | yes — agent (`agent.ts:477`) clears `sendStyle` for non-iMessage / downgraded turns; full message still sends |
| Tapback reactions (`POST /api/send-reaction`) | `reaction` | yes — all 6 (`love`, `like`, `dislike`, `laugh`, `emphasize`, `question`) match `SENDBLUE_REACTIONS` and the [reactions reference](https://docs.sendblue.com/api-v2/reactions/). Legacy aliases `heart`→`love`, `haha`→`laugh` accepted defensively | yes — `agent.ts:523` suppresses entire action on SMS/RCS/downgraded |
| Replies / threading | `reply` (intent only) | n/a — Sendblue exposes no native reply target; [API v2 docs list "Coming Soon"](https://docs.sendblue.com/api-v2/) | n/a — sent as plain message, target logged. iMessage-only `sendStyle` still degrades |
| Read receipts (`POST /api/mark-read`) | not a chat action — agent-side only | n/a | mark-read works for iMessage **and RCS** per [read-receipts reference](https://docs.sendblue.com/api-v2/read-receipts/), not SMS. **Cross-slice finding: `agent.ts:610-619` only fires when `channel === 'imessage'`, dropping legitimate RCS read receipts.** |
| Typing indicators (`POST /api/send-typing-indicator`) | not a chat action — agent-side only | n/a | iMessage-only per [typing-indicators reference](https://docs.sendblue.com/api-v2/typing-indicators/); agent suppresses on SMS/RCS/downgraded/group |
| Group send (`POST /api/send-group-message`) | routed automatically by `agent.ts` based on `conversation.type === 'group'` | n/a | group send works on iMessage only; `send_style` documented but typing/reactions are not |
| Carousel (V2 lines, `POST /api/send-carousel`) | **NOT modeled** | not exposed as a chat action | n/a |
| Contact card | achievable via `media` action with vCard URL ([Sendblue contact-card guide](https://docs.sendblue.com/guides/contact-card/)) | n/a | works on iMessage; degrades to SMS link if the recipient is not on iMessage |
| Silence / no-response | `silence` | n/a | n/a — no transport call |

## Findings

### Critical

None.

### Important

1. **Dead `resolveTargetRef` in `src/chat/actions.ts`** — `actions.ts` previously exported a second `resolveTargetRef` and `TargetResolution` (lines 218-254 in the pre-edit version) that nothing in `src/` or `tests/` consumed. The canonical resolver lives in `src/chat/target-resolver.ts`. The duplicate had inconsistent semantics (returned `'invalid-alias'` vs. `'not-found'` differently from the canonical version) and would have silently drifted from the agent's actual target resolution logic. **Fixed below.**

2. **`agent.ts:610-619` mark-read suppression is too strict (cross-slice)** — `shouldSendReadReceipt` requires `state.channel === 'imessage'`, but [Sendblue's read-receipts reference](https://docs.sendblue.com/api-v2/read-receipts/) explicitly states "Read receipts work for iMessage and RCS conversations, not SMS." This file is owned by the conversation slice; flagging only.

3. **`TargetRef.alias` type understates accepted spellings** — the type literal listed only `'latest' | 'previous' | 'first' | 'last'`, but `target-resolver.ts:74-78` accepts `'last|latest|current'`, `'first|oldest'`, `'previous|prior'`. Callers writing TS would not get autocomplete for `current`, `oldest`, `prior`. The open `(string & {})` branch hid the gap. **Fixed below.**

### Minor

4. **`docs/features/rich-chat-actions.md` does not enumerate Sendblue values** — the previous doc said "balloons, celebration, or another Sendblue-supported style" without listing the canonical 13 send_style values or the 6 reaction values, and contained no links to docs.sendblue.com. Hard to verify drift without going to source. **Fixed below.**

5. **Action-level silence + outbound mix vs. top-level silence + outbound mix** (`src/chat/contract.ts:25-35` vs. `src/chat/actions.ts:60-67`) — both produce `actions: []` with a `mixed-silence-actions` warning, but only the top-level path goes through `topLevelSilenceMixedWithActions`. The action-level path returns `{ actions: [], warnings }` with no `silence: true`, while the top-level path also omits `silence: true`. Consistent, but not documented in code. Added test coverage; no behavior change.

6. **`parseTaggedText` in `contract.ts:87-92` returns hardcoded `warnings: []`** — `parseTaggedActions` does not currently emit warnings, so this is correct today, but the type signature `warnings: []` (empty tuple literal) is a future hazard if `parseTaggedActions` ever starts surfacing warnings. Not fixed (low value, would touch the public surface of `parseTaggedText`).

7. **`media` action has no XML compatibility tag** — `parseTaggedActions` parses `message`, `no_response`, `reaction`, `reply` only. The XML bridge represents media via `<message media_url="...">`. This is consistent with AGENTS.md's "XML is a compatibility bridge, not a public surface." Documented in the doc rewrite.

8. **Contract-level recognition vs. action-level recognition divergence on `actions: []` empty** — `normalizeChatResponse` returns `{ actions: [] }` with no warning. `actions.length === 0` plus no other field would have thrown previously, but the `actions in response` check in `recognizedResponse()` covers it. Confirmed correct, added a regression test.

## Fixes Applied

- `src/chat/types.ts` — added JSDoc to every action type explaining iMessage-only behavior and Sendblue reference URLs; widened `TargetRef.alias` to the eight spellings the resolver actually accepts (`latest|last|current|previous|prior|first|oldest|(string & {})`); added `IMESSAGE_ONLY_ACTION_TYPES = ['reaction']` constant + `ImessageOnlyActionType` type so consumers can branch on transport-iMessage-only actions without hand-coding the list.
- `src/chat/actions.ts` — removed the dead duplicate `resolveTargetRef`, `TargetResolution`, and `ResolvedTarget` exports; kept the canonical resolver in `target-resolver.ts`. Pruned the now-unused `ChatEndpointMessage` import.
- `src/index.ts` — re-exported the new `IMESSAGE_ONLY_ACTION_TYPES` value and `ImessageOnlyActionType` type alongside the existing chat type re-exports.
- `tests/unit/chat-contract.test.ts` — added 13 cases covering: every Sendblue `send_style` round-trip, unknown `send_style` is dropped without dropping the action, every Sendblue reaction value, `heart`/`haha` legacy alias mapping, `media` action round-trip + missing-mediaUrl rejection, snake_case `media_url`/`send_style` input acceptance, empty `actions: []` recognized as no-op, action-level mixed silence, sole silence action, tagged `media_url` on message, nested message inside reply tag, and non-object payload rejection (string/array/null).
- `tests/unit/chat-target-resolver.test.ts` — added cases for all alias spellings (`current`, `oldest`, `prior`), no-target default to latest, `previous` with single-message history, negative/non-integer `partIndex`, `first`/`last` occurrence on ambiguous content, and case-insensitive content matching.
- `tests/unit/chat-client.test.ts` — added `HttpChatClient` suite (5 cases) covering: structured request POST shape (body includes `messageHandle`, `channel`, `conversation`, `identity`, `typing`, `sendblue`), non-2xx error mapping with status in message, fetch rejection wrapped as `ChatEndpointError` preserving `cause`, `chatResponseParseTags=false` keeping `<message>` literal, and malformed upstream throwing a `ChatEndpointError` instance.
- `docs/features/rich-chat-actions.md` — restructured the action table to call out iMessage-only columns and link to each Sendblue endpoint; enumerated the 13 canonical `send_style` values split into bubble vs. screen effects; enumerated the 6 canonical reaction values plus the legacy aliases the normalizer accepts; replaced vague language about resolver aliases with the actual accepted spellings; expanded "Known limitations" to cite Sendblue docs for replies, mark-read, typing indicators, and the unmodeled carousel endpoint.

`npm run typecheck` clean. `npx vitest run --config vitest.config.ts tests/unit/chat-client.test.ts tests/unit/chat-contract.test.ts tests/unit/chat-target-resolver.test.ts` runs 42 tests passing. Full `npm test` runs 159 unit + 49 integration tests passing.

## Missing Test Cases (still open)

The fixes above closed most gaps. The following are still uncovered and worth tracking:

- **Group conversation request shape** — `createChatRequest` in `src/chat/types.ts` does not populate the `conversation` object for groups; that is set by `agent.ts` before calling the chat client. A unit-level fixture verifying `agent.ts` produces `conversation.type === 'group'` and group metadata is the conversation slice's job, but a chat-client-level test asserting `HttpChatClient` does not strip group fields would protect against accidental over-trimming.
- **Empty body / non-JSON response** — `HttpChatClient` currently calls `response.json()` even on 200 responses with empty body. A test for a 204/empty-body upstream would lock in current behavior (which is to throw `ChatEndpointError` because `json()` rejects).
- **Abort-on-timeout** — `chatEndpointTimeoutMs` triggers `controller.abort()`. No test exercises the abort path. Skipped because it requires fake timers + real fetch, but worth adding.
- **`messages[]` with all-empty / whitespace-only entries** — current logic filters them out, but no explicit test for "every entry empty" returning `actions: []` (recognized).
- **Reply action that resolves to a missing handle** — covered by the conversation slice (agent skips with reason); not a chat-contract concern.

## Documentation Updates

- `docs/features/rich-chat-actions.md` — major rewrite of the action table, message/reaction field sections, and Known Limitations. Added direct links to:
  - https://docs.sendblue.com/api/resources/messages/methods/send/
  - https://docs.sendblue.com/api-v2/reactions/
  - https://docs.sendblue.com/api-v2/read-receipts/
  - https://docs.sendblue.com/api-v2/typing-indicators/
  - https://docs.sendblue.com/api-v2/carousel/
  - https://docs.sendblue.com/api-v2/
  - https://docs.sendblue.com/guides/contact-card/

A separate `docs/features/chat-contract.md` does not feel warranted right now — the existing file already covers contract shape, XML compatibility, group routing, and configuration. Splitting transport-side action semantics from request shape would duplicate the table and the legacy compatibility section. Recommend keeping a single doc until a future `actions[]` rev (e.g. carousel, native reply) needs a separate page.

## Open Questions

1. **Should `actions: []` (recognized but empty, no `silence: true`) be treated as silence or as a contract violation?** Today `normalizeChatResponse` returns `{ actions: [] }` with no warning. Practical effect: agent does nothing (same as silence) but the chat endpoint's intent is ambiguous. Could either (a) coerce to `{ silence: true, actions: [] }`, (b) emit a `recognized-empty-actions` warning, or (c) keep current behavior. Current is the most permissive; flagging because it differs from `silence: true` only in the absence of the explicit flag, and the agent treats the two identically.
2. **`reply` action with no Sendblue native reply support — should we still preserve the target on the wire?** Today the resolved target is logged but the outbound `send-message` body has no reference to it. If/when Sendblue exposes a native reply parameter, callers will not need to change. But until then, the chat endpoint's reply intent is not visible to the recipient. Acceptable per AGENTS.md, but worth re-confirming once Sendblue ships threaded replies.
3. **Carousel as a future chat action** — Sendblue's `send-carousel` accepts 2-20 image URLs. If this is added, should it be a `carousel` action or a richer `media` action with `mediaUrls: string[]`? Cleaner as its own action; flagging now to avoid retrofitting later.
4. **Mark-read on RCS (cross-slice)** — `agent.ts:617` blocks RCS read receipts contrary to Sendblue docs. Recommend the conversation-slice owner widen `shouldSendReadReceipt` to `state.channel === 'imessage' || state.channel === 'rcs'` (still excluding SMS and downgraded). Not in this slice's edit scope.
