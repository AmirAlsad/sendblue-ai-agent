# 03 — Conversation Agent & State

## Summary

The conversation agent correctly enforces the documented load-bearing rules
for keying, channel-aware ordered delivery, and group routing. The biggest
findings were partial enforcement of the "iMessage-only rich actions"
suppression rule from `AGENTS.md`: read receipts were also being attempted on
RCS, and reactions and `sendStyle` were being sent on SMS/downgraded
conversations. Those gaps are now patched, and small documentation drift was
corrected at the same time.

## Findings

### Critical

None.

### Important

1. **Read receipts were sent on RCS** — `src/conversation/agent.ts` (old
   `shouldSendReadReceipt`).
   - Observed: gate was `imessage || rcs`.
   - Expected: per `AGENTS.md` Sendblue Constraints, `mark-read` is direct
     iMessage-only. RCS and SMS/downgraded conversations must not call
     `/api/mark-read`.
   - Reference: `AGENTS.md` "iMessage-only rich actions ... must be suppressed
     or safely degraded for SMS and downgraded conversations" and
     `CLAUDE.md` "Read receipts are best-effort `POST /api/mark-read` ... no
     `READ` status callback".

2. **Reactions sent on SMS/downgraded conversations** —
   `src/conversation/agent.ts:sendReactionAction`.
   - Observed: no channel gate. A chat response with a reaction action would
     hit `client.sendReaction` even on SMS/downgraded conversations.
   - Expected: Tapback reactions are direct iMessage-only and must be
     suppressed/degraded.
   - Reference: same `AGENTS.md` Sendblue Constraints rule.

3. **`sendStyle` (send effects) forwarded on SMS/downgraded** —
   `src/conversation/agent.ts:sendOutboundAction`.
   - Observed: `if (item.sendStyle) message.sendStyle = item.sendStyle` for
     both direct and group sends, regardless of channel.
   - Expected: send effects are iMessage-only; degrade by dropping the style
     for SMS/downgraded conversations while still sending the text/media.
   - Reference: same.

4. **Group routing's "delivered message content substring" invocation gate is
   fragile** — `src/conversation/agent.ts:isInvokedGroupWebhook` (line ~709).
   - Observed: any group message that contains a previously delivered agent
     message as a substring is treated as addressed. If the agent sent the
     short message `"yes"`, a later group message `"yes please"` would invoke
     the agent.
   - Expected: tighter heuristic — Sendblue's tapback/reply payloads can
     reference an agent outbound `message_handle`, which is the safer signal
     (and is already covered by `referencedMessageHandles`). The substring
     fallback should be considered a soft signal and possibly required to
     match a longer floor. **Not patched** because changing this changes
     observable group routing behavior; flagging only.
   - Reference: `AGENTS.md` "Group receives are silent unless addressed to
     `AGENT_DISPLAY_NAME`, a best-effort Tapback/reply references a known
     agent outbound, or future payloads include explicit reply metadata".

5. **`logSecretRejection` is referenced but undefined in `src/http/app.ts`**
   (cross-slice — HTTP agent owns).
   - Observed during this audit: `npm run typecheck` initially failed with
     `TS2304: Cannot find name 'logSecretRejection'` at four call sites in
     `src/http/app.ts`. The reference is fixed by the time of report writing
     (the HTTP slice agent appears to have landed the definition), but it was
     a transient breakage worth flagging in case it returns.

### Minor

6. **Outbound-handle → conversation-key mapping not deleted on advance** —
   `src/conversation/agent.ts:advanceQueue` and `transitionToIdle`.
   - Mappings are only deleted on `interruptSending` and on `abortQueue`.
     Successful advances leave the mapping in Redis until
     `CONVERSATION_TTL_SECONDS`. Benign (no functional impact), but it
     produces stale keys. Low-priority cleanup.

2. **`smsDowngraded` is cleared when an iMessage receive arrives** —
   `src/conversation/agent.ts:applyChannel`.
   - `AGENTS.md` calls `was_downgraded` "conversation-significant state".
     The current behavior allows the flag to flip back to `false` if the
     recipient comes back on iMessage. This is defensible (when a recipient
     regains iMessage, suppressing iMessage-only features forever would be
     wrong), but the rule's phrasing is ambiguous. Documented this explicitly
     in `docs/features/conversation-state.md`. No code change.

3. **`channelFromStatus` does not respect `wasDowngraded === false`** —
   `src/conversation/agent.ts` (bottom of file).
   - If a previously-downgraded conversation receives a status update with
     `was_downgraded: false`, the function returns `'sms'` only when
     `wasDowngraded === true`, so `false`/`null` correctly falls through to
     service-based mapping. No bug, just worth noting that
     `applyChannel` is what actually clears `smsDowngraded` (and only when
     channel becomes `'imessage'`). A status update with `service: "iMessage"`
     does clear it through this path — verified.

4. **`InMemoryConversationStore.claimInboundHandle` is effectively atomic**
   only because it has no `await` between read and write. Document this
   invariant if it ever changes; concurrent dedupe in a single Node process
   relies on the synchronous body. No fix needed today.

5. **`mentionsAgent` regex requires a leading boundary** — agent.ts ~line 854.
   - `(^|\\s)@?${escaped}(\\b|\\s|[:,.!?])`. The lookbehind portion `(^|\\s)`
     means a name pasted after a non-space char like a `>`-quote prefix
     (e.g., `>sb-agent hi`) would not match. Probably acceptable; flagging
     because group-addressing edge cases tend to surface in live tests.

## Fixes Applied

| File:line | Change | Why |
| --- | --- | --- |
| `src/conversation/agent.ts:shouldSendReadReceipt` | Restricted to `channel === 'imessage'` (was `imessage || rcs`). | Sendblue `mark-read` is iMessage-only per `AGENTS.md`. |
| `src/conversation/agent.ts:sendReactionAction` | Added a `supportsImessageRichAction(state)` gate; reactions on SMS/downgraded are skipped with a clear `skipReason`. | Tapback is iMessage-only. |
| `src/conversation/agent.ts:sendOutboundAction` | `sendStyle` is dropped on SMS/downgraded conversations; text/media still sends. Logs a debug line on drop. | Send effects are iMessage-only; the rule says "safely degrade". |
| `src/conversation/agent.ts` | Added private `supportsImessageRichAction(state)` helper and routed `shouldSendTypingIndicator` through it. | Single source of truth for iMessage rich-action gating. |
| `tests/integration/conversation-intelligence.test.ts` | Added five new test cases (see Missing Test Cases below). | Lock in the new gating and cover gaps. |
| `docs/features/conversation-state.md` | Removed the (now-incorrect) claim that the legacy `channel` maps RCS to `unknown`; added a section describing iMessage-only gating across read receipts, send effects, reactions, typing. | Doc was drifting from code in two places. |
| `docs/features/ordered-delivery.md` | Tightened the channel-aware status section: explicitly noted that Sendblue docs only confirm iMessage→DELIVERED and SMS→SENT, and that the RCS-on-DELIVERED treatment is an internal default rather than a Sendblue-documented terminal state. Linked to the Sendblue webhooks and send-message docs. | Calibrate doc against `AGENTS.md` and live `https://docs.sendblue.com/...` content. |
| `docs/features/message-buffering.md` | Added a sentence noting that the conversation record is one record across iMessage/RCS/SMS/downgrade. | Reinforce the load-bearing rule the file was implicitly relying on. |

## Missing Test Cases (added or recommended)

Added in this slice:

- `drops iMessage send effects on downgraded SMS conversations but still sends text` — verifies `sendStyle` degradation on SMS.
- `skips reactions on SMS or downgraded conversations and continues the queue` — verifies the new reaction gate; also checks the queue advances past the skipped reaction.
- `does not send a read receipt on RCS conversations` — verifies the tightened RCS gate.
- `keeps the same conversation record across an iMessage to SMS downgrade` — locks in single-record behavior across a channel transition.
- `aborts the queue and stops typing on ERROR status` — covers the abort path that previously had no integration test.

Recommended (not added — would touch BullMQ or require extra plumbing):

- BullMQ scheduler integration test (gated behind a Redis-available env). The `BullMqBufferScheduler` is currently exercised only through the type system.
- A dedupe race test exercising the in-memory atomicity invariant: fire two concurrent `handleReceive` promises for the same `message_handle` and assert exactly one is processed. The current promise-await path makes this functionally serial, but a regression to a non-atomic store would not be caught.
- A test that explicitly fails the substring "delivered message content" group invocation heuristic (e.g., agent sent `"yes"`, user later writes `"yes please"`) so the brittleness from Finding 4 is visible.
- A test that exercises a status callback arriving for a `messageHandle` whose conversation has already moved past `sending` (delayed callback after timeout-driven advance). Today this returns silently; document or assert that explicitly.
- A typing-indicator test for an inbound where neither forward nor reverse direct conversation exists yet: verify the configured `SENDBLUE_FROM_NUMBER` heuristic picks the correct key shape.

## Documentation Updates

- `docs/features/conversation-state.md`:
  - Removed the obsolete RCS-mapped-to-unknown note.
  - Added the explicit iMessage-only gating table for read receipts, send effects, reactions, and typing indicators.
- `docs/features/ordered-delivery.md`:
  - Tightened the channel-aware section. SMS terminal is `SENT`; iMessage terminal is `DELIVERED`. Marked the RCS→DELIVERED treatment as an internal default that is not Sendblue-documented and should be revisited against captured RCS callbacks.
  - Added links to the relevant `https://docs.sendblue.com/getting-started/webhooks/` and `https://docs.sendblue.com/getting-started/sending-messages/` pages.
- `docs/features/message-buffering.md`:
  - Added a sentence reaffirming the one-record-across-channels rule.

## Open Questions

1. **Should `smsDowngraded` ever clear?** `AGENTS.md` calls it "conversation-significant state". The current behavior clears it on a fresh `service: "iMessage"` receive. Two viable interpretations: (a) iMessage suppression should re-engage as soon as iMessage is restored (current behavior, intuitive for end-user UX), or (b) once downgraded, treat the conversation as SMS-eligible forever in a session window. Pin one in `AGENTS.md`.

2. **RCS terminal status.** Sendblue public docs cover iMessage and SMS but not RCS specifically. The agent currently advances RCS queues on `DELIVERED`. If real RCS callbacks turn out to terminate at `SENT`, this needs a flip. Worth a captured E2E run on RCS specifically. (Flagged in `ordered-delivery.md` already.)

3. **Group invocation by content substring.** Finding 4 above is a behavioral question, not a bug. Should we keep the heuristic (false positives on short replies) or drop it and rely solely on `referencedMessageHandles` + `mentionsAgent`? Probably should be a documented config knob (e.g., `GROUP_INVOCATION_CONTENT_FALLBACK=on|off`).

4. **Outbound-handle map cleanup on advance.** Should `advanceQueue` and `transitionToIdle` proactively delete the outbound-handle mappings they no longer need? The TTL handles this eventually, but Redis would be cleaner. Low priority.

5. **Sendblue webhook signing header.** Out of slice (HTTP agent owns), but flagging that the signing-header name is still configurable (`SENDBLUE_WEBHOOK_SECRET_HEADER`) per Sendblue docs not specifying it. The conversation agent does not depend on the validation outcome (HTTP layer rejects before us), so no work here.
