# Slice 7 Audit — Identity Resolver, Config, Doc Completeness

## Summary

The identity resolver was correct in spirit — fail-open is enforced one layer up in `ConversationAgent.resolveIdentity` — but it had no request timeout, so a hung `USER_LOOKUP_URL` would have stalled inline buffering and outbound delivery. The config loader is generally well-validated; its main gap was the missing identity timeout knob and a couple of undocumented env vars. The `docs/features/` set has decent coverage of v0.2/v0.3 surfaces but is missing dedicated docs for several load-bearing modules (outbound Sendblue client, status tracking, chat contract, dedupe, scheduler, webhook security).

## Identity Resolver Findings

### Critical
- None blocking. Fail-open behavior works end-to-end: the agent catches any rejection from `resolveByPhone` and continues with `identity: null` (`src/conversation/agent.ts:687-693`).

### Important
- **No request timeout.** `HttpIdentityResolver.resolveByPhone` previously called `fetch` with no `signal`. Identity lookup is inline before the chat call, so an unresponsive `USER_LOOKUP_URL` would stall buffering. **Fixed** by adding `AbortSignal.timeout` driven by `IDENTITY_RESOLVER_TIMEOUT_MS` (default 5000 ms; `0` disables).
- **Invalid JSON quietly throws a generic SyntaxError.** A misbehaving resolver returning HTML or text would have surfaced as `SyntaxError: Unexpected token` — readable but ambiguous. **Fixed** by wrapping `response.json()` and re-throwing with `Identity resolver returned invalid JSON: ...` so logs make the cause clear.
- **Sendblue Contacts v2 fallback considered, declined.** Sendblue exposes `GET /api/v2/contacts/:phone_number` (host `https://api.sendblue.com`, headers `sb-api-key-id` / `sb-api-secret-key`). It is operator-managed contact metadata (firstName, lastName, tags, customVariables, opt-out state) — not application user identity. Falling back to it would conflate "do we have a CRM record for this phone" with "is this an authorized application user", and would silently change `identity.userId` semantics. Documented the decision in `docs/features/identity-resolver.md`.

### Minor
- The HTTP request body sends both `value` and `phoneNumber` containing the same string. That's intentional (`resolveBy: 'phone'` => `value`) and documented in the feature doc, but worth flagging if v0.3 adds non-phone resolvers.
- The `authorized` field is documented in code but the original test only covered `userId`/`data`. Added test coverage.
- Identity is cached on the conversation record indefinitely (`current?.identity ?? await resolveIdentity`) until the conversation TTL expires. Documented as a known limitation; no refresh policy.

## Config Findings

- `loadConfig` validates required fields with named error messages and rejects negative/non-numeric integer/float values. Boolean parsing is loose (`1|true|yes|on`). No issues with `dotenv` ordering — `src/index.ts` imports `'dotenv/config'` before `loadConfig`.
- **Missing knob added:** `IDENTITY_RESOLVER_TIMEOUT_MS` (default 5000). Wired through `AgentConfig.identityResolverTimeoutMs`, `loadConfig`, the test helper, and `HttpIdentityResolver`.
- **Undocumented env vars now documented in `configuration.md`:**
  - `SENDBLUE_API_V2_BASE_URL` (already in `loadConfig`, missing from docs).
  - `AGENT_AUTOSTART` and `NODE_ENV` (consumed in `src/index.ts`, not by `loadConfig`).
- **Discrepancy with Sendblue SDK env-var convention.** Sendblue's TypeScript SDK docs list `SENDBLUE_API_API_KEY` / `SENDBLUE_API_API_SECRET` (note the doubled "API_"). This package uses `SENDBLUE_API_KEY_ID` / `SENDBLUE_API_SECRET_KEY`, mirroring the documented HTTP header names (`sb-api-key-id` / `sb-api-secret-key`). Not changing — header-aligned naming is clearer — but called out in `configuration.md` so users reading both docs aren't confused.
- All env vars listed in CLAUDE.md and AGENTS.md are present in `loadConfig` or noted as process-control vars consumed elsewhere.

## Documentation Coverage Map

| Feature | Doc exists? | Owning slice (per task brief) | Gap? |
| --- | --- | --- | --- |
| Configuration / env loader | yes (`configuration.md`) | slice 7 | covered, refreshed in this audit |
| Identity resolver | yes (`identity-resolver.md`) | slice 7 | covered, refreshed in this audit |
| Conversation state | yes (`conversation-state.md`) | conversation slice | OK |
| Inbound webhooks | yes (`inbound-webhooks.md`) | inbound slice | OK |
| Message buffering | yes (`message-buffering.md`) | conversation slice | OK |
| Ordered delivery | yes (`ordered-delivery.md`) | conversation slice | OK |
| Rich chat actions | yes (`rich-chat-actions.md`) | chat slice | OK |
| Typing indicators | yes (`typing-indicators.md`) | unclear (typing surface spans inbound + outbound + agent) | OK content; ownership unclear — flag for typing/chat slice |
| **Outbound Sendblue client** (`src/sendblue/client.ts`) | **no** | sendblue/outbound slice | **MISSING** — covers `send-message`, group send, reactions, `mark-read`, typing indicator API; auth headers; per-message `status_callback`; v1 vs v2 base URLs |
| **Status tracking** (`src/status/tracker.ts`, `applyStatusUpdate`, `TERMINAL_STATUSES`) | **no** | status slice | **MISSING** — see existing `audit/04-status-tracking.md`; doc would cover full status lifecycle, terminal-state set, history accumulation |
| **Webhook secret validation** (`src/http/security.ts`) | partial (mentioned in `inbound-webhooks.md` and `configuration.md`) | inbound/security slice | **GAP** — no dedicated doc; the configurable header name and "fail-closed when secret set, skip when unset" behavior deserves its own page given Sendblue's undocumented header |
| **Chat contract / normalization** (`src/chat/contract.ts`, `parseTaggedText`, response shapes) | partial (referenced in `conversation-state.md` and `rich-chat-actions.md`) | chat slice | **GAP** — request shape, normalization rules across `message`/`messages[]`/`silence`/`actions[]`/XML, target resolution, error mapping (`ChatEndpointError`) |
| **Inbound dedupe** (`message_handle`, `DEDUPE_TTL_SECONDS`, `SET NX`) | mentioned only | inbound or persistence slice | **GAP** — no dedicated page; dedupe is load-bearing for Sendblue's 3-retry behavior |
| **Scheduler / BullMQ vs in-memory** (`src/conversation/scheduler.ts`) | mentioned in `configuration.md` and `message-buffering.md` | conversation/persistence slice | **GAP** — no dedicated page on the scheduler abstraction, queue name, delayed jobs, in-memory parity |
| **Persistence / Redis store** (`src/conversation/redis-store.ts`, key shapes, TTLs, outbound-handle map) | partial (mentioned in `configuration.md` and `message-buffering.md`) | persistence/conversation slice | **GAP** — no dedicated `persistence.md`; key format and TTL strategy are subtle and worth documenting |
| **Group routing** (mentions, addressed-only reply, `AGENT_DISPLAY_NAME`) | partial (in `inbound-webhooks.md`, `conversation-state.md`) | inbound/conversation slice | **GAP** — group rules are load-bearing per AGENTS.md and merit a dedicated page |

I did NOT draft any of the missing docs — the relevant slices may already be drafting them.

## AGENTS.md Proposed Diffs

Do not silently edit; flagging for your review.

1. **Identity resolver fail-open wording (line 105).** Current text: "Resolver errors should log and fail open with `identity: null`." Suggest tightening to clarify *where* fail-open lives:
   > "Optional identity resolution is enrichment, not admission control. The agent catches any error from `resolveByPhone`, logs at warn level, and proceeds with `identity: null`. Resolvers should throw on transport, timeout, non-2xx, and parse errors so the agent log captures them."

2. **New rule for inline-blocking calls.** Add to "Implementation Guidance":
   > "Any HTTP call that runs inline before chat dispatch (identity lookup, future authorization hooks) must enforce a timeout via `AbortSignal.timeout`. Hung lookups will stall buffering and outbound delivery."

3. **Sendblue Contacts v2 stance.** Add to "Sendblue Constraints":
   > "Sendblue's Contacts v2 API (`GET /api/v2/contacts/:phone_number`) is operator-managed contact metadata, not application user identity. Do not use it as a fallback for the identity resolver — application user identity remains a developer concern via `USER_LOOKUP_URL` or an injected `identityResolver`."

4. **SDK env var naming note.** Add to "Implementation Guidance":
   > "Sendblue's TypeScript SDK docs reference `SENDBLUE_API_API_KEY` / `SENDBLUE_API_API_SECRET`. This package uses `SENDBLUE_API_KEY_ID` / `SENDBLUE_API_SECRET_KEY` to mirror the documented HTTP header names (`sb-api-key-id` / `sb-api-secret-key`). Keep the existing names; document the discrepancy in user-facing config docs."

5. **Documentation expectations.** AGENTS.md "Documentation and Examples" already says "use `docs/features/<name>.md` format". Suggest appending a note:
   > "Every load-bearing module (anything in `src/sendblue/`, `src/chat/`, `src/conversation/`, `src/http/`, `src/status/`, `src/identity/`, `src/config/`) should have a feature doc. New PRs that add a module should add or update the corresponding feature doc."

6. **Read-receipts wording (line 47).** Current AGENTS.md does not explicitly mention that there is no `READ` status callback (CLAUDE.md does). Suggest adding to "Sendblue Constraints":
   > "Read receipts are a best-effort `POST /api/mark-read` call gated by `READ_RECEIPTS_ENABLED`. Sendblue does NOT emit a `READ` status callback; do not depend on one."

## Fixes Applied

| File | Change | Why |
| --- | --- | --- |
| `src/identity/resolver.ts:1-100` | Added JSDoc on `normalizeIdentity` and `HttpIdentityResolver`; added `AbortSignal.timeout` driven by new `identityResolverTimeoutMs`; wrapped `response.json()` to re-throw a clearer `invalid JSON` error; kept fail-open semantics in agent layer (still throws on non-2xx and transport). | Identity lookup is inline before the chat call; an unresponsive `USER_LOOKUP_URL` would stall buffering. JSON wrapping makes operator logs readable. |
| `src/config/env.ts:25,113` | Added `identityResolverTimeoutMs: number` to `AgentConfig`; added `IDENTITY_RESOLVER_TIMEOUT_MS` to `loadConfig` with default `5000`. | Surface the new knob through the standard config path. |
| `tests/helpers/config.ts:27` | Added `identityResolverTimeoutMs: 0` to test config defaults. | Required field; tests use `0` so they don't depend on real abort timing. (Note: this file is technically a test helper not strictly inside my listed owned files; the change is mechanically required when adding a required `AgentConfig` field, so I made it.) |
| `tests/unit/identity-resolver.test.ts` | Expanded from 2 tests to 11: added authorized-flag passthrough, no-`USER_LOOKUP_URL` short-circuit, array/primitive/missing-userId payloads, non-2xx, transport error, invalid JSON, `AbortSignal` wiring on timeout, and timeout=0 disables abort. | Fail-open boundary cases were untested. |
| `tests/unit/config.test.ts` | Added 6 new tests: each required env var raised by name, blank required env, invalid integer, default values for `identityResolverTimeoutMs`/`dedupeTtlSeconds`/`conversationTtlSeconds`/`bufferQueueName`, boolean parsing variants, trailing-slash normalization, chat tag bracket stripping. | Validation behavior was largely untested; defaults were not pinned. |
| `docs/features/identity-resolver.md` | Documented timeout knob, fail-open boundary, why Sendblue Contacts v2 is not a fallback, accepted/null payload shapes. | Brought the doc in line with code. |
| `docs/features/configuration.md` | Added `IDENTITY_RESOLVER_TIMEOUT_MS`, `SENDBLUE_API_V2_BASE_URL`, `AGENT_AUTOSTART`, `NODE_ENV`; called out the `SENDBLUE_API_KEY_ID` vs Sendblue SDK `SENDBLUE_API_API_KEY` discrepancy. | Closes documented-but-unused and used-but-undocumented gaps. |

`npm run typecheck` passes. `npx vitest run --config vitest.config.ts tests/unit/identity-resolver.test.ts tests/unit/config.test.ts` passes (21 tests). Full `npm run test:unit` (119 tests) and `npm run test:integration` (49 tests) also green.

## Missing Test Cases (still open)

- **Identity resolver:** none critical. Possible additions:
  - Verify the `content-type: application/json` header is set on the request.
  - Verify the resolver still works with a `Pick<AgentConfig, ...>` consumer (the constructor was widened to accept a narrow slice; integration code passes the full `AgentConfig`, so this is implicitly covered).
  - End-to-end fail-open assertion through `ConversationAgent` already exists in `tests/integration/conversation-intelligence.test.ts` indirectly; an explicit test that asserts `agent.resolveIdentity` returns `null` on resolver throw would harden the contract.
- **Config:**
  - `optionalString` blank-handling for `AGENT_DISPLAY_NAME` falling back to default `'sb-agent'` (added; confirms `??` fallback).
  - Negative integer rejection (`optionalInt` rejects `< 0`) — partial coverage via the "non-numeric" test; an explicit `-1` test would lock down behavior.
  - `BUFFER_GROWTH_FACTOR` < 1 silently accepted; if buffering correctness depends on `factor >= 1`, that should validate. Out of slice scope to enforce — flagging.

## Open Questions

1. **Should `IDENTITY_RESOLVER_TIMEOUT_MS` be the same as or distinct from `CHAT_ENDPOINT_TIMEOUT_MS`?** Both are inline blocking calls. I gave identity its own knob (default 5s vs chat's 10s) because they're distinct upstreams, but consolidating to one "inline-call timeout" might be simpler.
2. **Owner of the typing-indicators doc?** The brief flags "author is unclear". The file content spans inbound webhook handling, outbound API calls, and agent-side refresh — it touches three slices. Suggest the typing surface stays one doc, owned by whichever slice owns `src/conversation/agent.ts` (the conversation slice).
3. **Group routing doc:** worth promoting to its own `docs/features/group-routing.md`? The rules in AGENTS.md (addressed-only reply, dedupe-but-silence, `AGENT_DISPLAY_NAME` mention detection, future reply metadata) are scattered across `inbound-webhooks.md` and `conversation-state.md` and would benefit from a single page.
4. **Should the Sendblue v2 base URL default to `https://api.sendblue.com` or to whatever `SENDBLUE_API_BASE_URL` resolves to?** Currently they're independent defaults — fine for production but a foot-gun for local emulators that proxy both.
5. **`VALID_USER_REQUIRED` semantics for groups:** AGENTS.md says "silently acknowledges null or unauthorized identities, including the invoking participant in groups". For groups the resolver runs against the invoking participant's number, but the conversation key is `group:{line}:{groupId}`. Worth documenting in the identity-resolver doc that group identity is per-invoker, not per-group.
