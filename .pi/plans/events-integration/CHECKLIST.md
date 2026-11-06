# Execution checklist: capability-gated Pi events integrations

Sources: [PLAN.md](PLAN.md), [EXECUTION_PLAN.md](EXECUTION_PLAN.md).

## Objective / prerequisite decisions

- [x] Inspect working tree, roadmap, status publisher, owner/input/output/history helpers and pinned Pi 1.4.0 declarations/implementation.
- [x] Record public-API blockers: strict conversation delivery correlation, exact queue depth, generic attention replies.
- [x] Settle capability-gated scope; unsupported APIs must never dispatch input or simulate approvals.
- [x] Write planning package only; preserve prior uncommitted implementation and docs.
- [x] Parent accepts plan handoff and starts exact sequential implementation/review loop.

## 1. Baseline, contracts and request infrastructure

- [x] Capture original tracked/untracked file list and run baseline check/test/build without modifying environment/dependencies.
- [x] Reproduce or disprove reported existing agents.test.ts failure; record evidence separately from new failures.
- [x] Define channels, explicit DTOs, executable field validators, finite UTF-8 limits and fixed errors.
- [x] Add default-off content/control flags, distinct from metadata observation.
- [x] Implement epoch/client/request validation and bounded 10-minute idempotency cache.
- [x] Test duplicate replay, conflict (including changed operation), stale owner, cache saturation and deadlines without redispatch.
- [x] Ensure frozen/fresh DTOs prevent subscriber mutation of caches; catch own handler failures without leaking exception/payload text.

## 2. Metadata, lifecycle and unsupported families

- [x] Reuse one existing capabilities publisher; add integrations metadata without changing status.observationOnly or old fields.
- [x] Implement main phase/turn/tool/pending metadata and late-subscriber ping replay with anchored 250ms coalescing.
- [x] Advertise queueDepth:null and exactQueueDepth:false, not a guessed count.
- [x] Implement bounded UI-prompt metadata only, no title/options/reply handles.
- [x] Reject conversation submit/queue/steer and generic attention replies with UNSUPPORTED_API; prove zero input dispatch, permission decisions and memory writes.
- [x] Implement ready/replayed-ready/closing generation events and subscribe-before-advertise order.
- [x] Verify same-session rebind, profile replacement, failed open, shutdown, old callbacks, plain/remote/joined sessions and owner headless modes.
- [x] Preserve existing agent-status tests and late ping order.

## 3. Opt-in assistant output

- [x] Implement subscribe/renew/unsubscribe/resync with owner/client/subscription validation and eight-subscription/lease caps.
- [x] Project assistant text only; exclude thinking, tool calls/results, partial objects, errors, args and unrelated custom/system messages.
- [x] Correlate generated turn/message IDs; final text reconciles deltas, settlement terminates activity.
- [x] Implement bounded delta batches, gap markers, replacement chunks and bounded recovery snapshots.
- [x] Test no-delta finals, retries/aborts/errors, late subscribers, stream gaps, Unicode/escaping byte caps and unsubscribe/shutdown cleanup.
- [x] Prove content-off mode broadcasts no text and subscriptions do not cause input/control work.

## 4. Authorized agent controls and explicit content reads

- [x] Adapt spawn/steer/resume/stop through Children methods with existing model/depth/maxAgents policies.
- [x] Enforce current owner cwd, explicit delegation authorization, top-level/non-connected ownership, expectedStartedAt and exact operation/state semantics.
- [x] Prove steer cannot race into implicit resume; use only a narrow preconditioned public helper if necessary and reviewed.
- [x] Verify stop method completion is not described as run exit; late/timed-out methods cannot emit twice or against replacement owners.
- [x] Add bounded recent-current-session branch paging with opaque owner/client-scoped cursors and byte/item/snapshot caps.
- [x] Project selected run assistant text from retained messages, never arbitrary report/error strings; document source-read vs response bounds.
- [x] Test disabled control policy, unknown/connected/nested/stale runs, no arbitrary cwd/path, and control source immutability.
- [x] Test malicious cursors, bounded history projection, and selected-result source immutability.

## 5. Docs, full validation and acceptance

- [x] Replace roadmap-only assertions with exact implemented/enabled/unsupported matrix, concrete envelopes and all advertised limits.
- [x] Provide an in-process bridge example with subscribe-before-ping, per-owner binding, external ACL responsibilities, opt-ins, dedupe and disposal; no Discord credentials/dependencies.
- [x] Explicitly state that strict conversation initiation and generic remote approvals are unavailable.
- [x] Run targeted real-Pi fixtures plus npm run check / npm test / npm run build / git diff --check; record exits and bounded logs.
- [x] Compare baseline and final results; investigate every new failure. Never label an unverified failure pre-existing.
- [x] Review privacy sentinels across metadata, capabilities, errors and content-only surfaces.
- [x] Review file boundaries: no dependency/lockfile, core/durable, memory-format, prompt or TUI changes; preserve all prior work.

## 6. I10 implementation validation and R1 handoff

- [x] Re-run the complete I1-I9 event suites plus status/lifecycle/headless/session-switch/agents regressions with bounded commands.
- [x] Re-run check, full test, build, and diff validation; compare exactly with the accepted 495/493/1/1 baseline.
- [x] Audit every changed/untracked file, dependency/lockfile state, prohibited scope, and HEAD identity.
- [x] Audit privacy sentinels, default-off gates, unsupported-operation zero effects, and public-API-only seams with exact grep evidence.
- [x] Record implemented/default-disabled/unsupported families, all residual limits, final validation table, and the read-only R1 handoff.
- [x] Make no runtime/source correction; stop before R1.

## 7. F1 findings-only repair

- [x] H1: retain unsettled timed-out mutation records, slots, bytes, and uncertainty guards until actual settlement.
- [x] M1: correlate each queued delta batch with its assistant turn/message and prevent cross-message mixing.
- [x] M2: distinguish deferred continuation items from permanently omitted history entries and align `truncated` with actual loss.
- [x] M3: publish a matching failed-open closing event after readiness and remove owner listeners.
- [x] M4: retain bridge request IDs through `accepted` and remove them only at terminal `completed`/`rejected`, with owner checks.
- [x] M5: retain oversized assistant text incrementally within the byte cap on a Unicode boundary.
- [x] L1: accept the documented explicit-null attention reply payload and retain the zero-effect unsupported rejection.
- [x] L2: correct and cross-check every operation's request/result channel mapping.
- [x] Add focused regression tests, re-audit privacy/default-off/unsupported/public seams, and record exact F1 validation.
- [x] Preserve the 26-file boundary and dependency/lockfile/HEAD state; stop before R2.

## 8. F2 contract-accuracy repair (fix cycle 2 of 2)

- [x] Rename the obsolete per-second-named event limit key to `queuedDeltaBytes` with value 32768 across source, tests, docs, and plans.
- [x] Source the existing output queue ceiling from the corrected limit without changing batching, cadence, gaps, overflow, or runtime behavior.
- [x] Document the limit precisely as an instantaneous per-subscription queued-delta buffer ceiling with no per-second throughput/token budget.
- [x] Add a capability regression and retain the exact 32 KiB overflow-to-gap regression.
- [x] Extend/retain the docs limits-table cross-check and verify no obsolete key remains.
- [x] Re-run targeted, full, check, build, diff, privacy/opt-in/zero-dispatch audits; preserve the 26-file boundary, dependency/lockfile state, and HEAD.
- [x] Stop before final R2 acceptance.

## Engineering loop gates

- [x] PLAN: openai-codex/gpt-6.1-sol, High, accepted by parent.
- [x] IMPLEMENT I1-I7: minimax/MiniMax-M3, Medium, bounded sequential slices.
- [x] IMPLEMENT I8: minimax/MiniMax-M3, Medium, bounded history/results.
- [x] IMPLEMENT I9: minimax/MiniMax-M3, Medium, Discord-facing documentation/acceptance cross-check.
- [x] IMPLEMENT I10: final implementation validation and review handoff.
- [x] REVIEW: openai-codex/gpt-6.1-terra, High, read-only severity-ranked findings (BLOCK; eight findings).
- [x] FIX if needed: minimax/MiniMax-M3, Medium, findings-only F1 edits plus regression tests.
- [x] REVIEW R2: openai-codex/gpt-6-luna, High, accepted all eight F1 repairs; found one limit-name acceptance defect.
- [x] FIX F2: contract-only queued-delta limit rename plus regression/docs correction; no runtime behavior change.
- [x] FINAL R2 ACCEPTANCE: openai-codex/gpt-6-luna, High, independent acceptance after F2 — ACCEPT, no remaining findings.
- [x] At most two fix/review cycles; unresolved blockers return to operator, not endless iteration.

## Rollout / rollback / done

Rollout order: metadata/unsupported gates -> opt-in output -> opt-in controls/reads -> docs -> independent review. Defaults remain observation-only with content/control disabled.

Rollback: disable new flags first; remove only new integration wiring/modules/tests if needed. Retain original agent-status implementation, roadmap history, unrelated uncommitted files and existing user work. Never use blanket git reset/checkout/clean.

Done means feasible families have tested advertised contracts, unsupported families remain explicit, baseline/final evidence and review are reported, no new failures are hidden, and no commit/push or external Discord delivery occurred. A fully implemented conversation-input or reply-capable attention API is **not** a done criterion against Pi 1.4.0.
