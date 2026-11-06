# Execution plan: capability-gated Pi events integrations

Sources: [PLAN.md](PLAN.md), [CHECKLIST.md](CHECKLIST.md), `docs/events-integration.md`, `docs/agent-status.md`.

## Orchestration rules / exact operator routing

Use **OptChat native subagents only**, no nested agents. The main agent coordinates decisions/reporting and acceptance; children never delegate. Phases are sequential, max three active agents globally, **one writer** in this worktree. Preserve existing uncommitted work. No commits/pushes, dependency upgrades, private Pi internals, TUI or memory-format changes.

Exact phase route:
1. PLAN: `openai-codex/gpt-6.1-sol`, **High** (this package).
2. IMPLEMENT: `minimax/MiniMax-M3`, **Medium**, steps I1–I10 sequentially.
3. REVIEW: `openai-codex/gpt-6.1-terra`, **High**, step R1, read-only.
4. FIX if needed: `minimax/MiniMax-M3`, **Medium**, step F1, findings-only.
5. FINAL REVIEW: `openai-codex/gpt-6-luna`, **High**, step R2, read-only.

Maximum **two fix/review cycles total**. If final review requires a second repair, parent may run one more MiniMax fix -> Luna review; afterward stop/report remaining issues. Do not restart implementation or change models silently. The implementation phase may reuse/resume one native worker across these checkpoint slices; it must not own the entire roadmap in an unbounded assignment. Each slice normally needs 10–20 turns; if incomplete at checkpoint, hand back precise remaining work, not an autonomous new subagent. User routing overrides generic skill template model defaults.

Each handoff contains changed files, decisions, tests/exit codes, remaining blockers, next slice; no full transcripts or large logs. Steps below use `implementor` role unless marked review/validation. Parent updates checklist after validating a checkpoint. Bounded-turn guidance is for slice sizing, not permission to abandon required validation or use nested workers.

## Commands / evidence conventions

- Every shell call <=60s. Use `timeout 55s ... > /tmp/optchat-events-<stage>.log 2>&1`, then separate `tail -60`/exit-code reads. Never wait >60s in one call.
- A suite exceeding 55s: start with redirected logs/exit marker in the background, announce the wait, poll in separate <=30s calls, and stop if an agreed overall deadline is exceeded (suggest 180s). Do not launch duplicate suites while one is alive.
- Targeted unit command template: `timeout 55s node_modules/.bin/tsx --import ./test/support.ts --test <named-test-files>`.
- Gate commands: `timeout 55s npm run check`, `timeout 55s npm run build`, `npm test` with the bounded/background pattern, `git diff --check`.
- Test only synthetic ModelRuntime fixtures and local temporary profiles. Do not use real credentials, user data, Discord or external model calls.

## I1. Reconfirm pinned seams and baseline

**Depends:** accepted PLAN. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 12 turns. **Write scope:** plan checkpoint notes only.

Read package/lockfile, current working-tree diff, `src/agent-status.ts`, public Pi ExtensionAPI/EventBus types, `src/index.ts` lifecycle/input handling and existing `test/agent-status-lifecycle.test.ts` fixture. Capture check/test/build baseline without upgrades. Confirm blocker evidence from PLAN: void sendUserMessage + no queue provenance, boolean pending only, no generic UI reply handles. Identify actual request attach/dispose points including repeated bind and failed initialization. Record the existing agent-status uncommitted files so later diffs preserve them.

**Acceptance/checkpoint:** versions, baseline exits and known failure evidence, owner attach/dispose mapping. A baseline failure is not automatically a new blocker, but must be independently recorded; dependency absence, missing public events or unexpected user edits require stop/report. Do not access underscore/private SDK state or capture raw AgentSession via test-style tricks in production.

## I2. Explicit DTOs, policy flags and validators

**Depends:** I1. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 18 turns.

**Write scope:** `src/events-contract.ts`, `test/events-contract.test.ts`; narrow flag registration in `src/index.ts`. Explore only public types and existing identifier/text projection helpers.

Implement literal channel names, capabilities integration DTO, owner epoch envelopes, operation discriminants and limits from PLAN. Establish schemas for main/owner/attention snapshots, requests/results, output subscriptions/events and history pages; no raw objects/unknown source spreads. New flags content/control default false and independent. Parse unknown payloads into allowlisted executable DTOs; fixed error enum, malformed routing rejection/ignore behavior, no thrown getter/exception text in warnings. Validate total executable string bytes before hashing/dispatch; unknown additive fields are ignored, forbidden semantic fields (cwd/parent impersonation) rejected.

**Tests:** exact keys, unknown additive fields, unsupported versions/ops, missing IDs/epoch, nonfinite values, oversized ASCII/Unicode/JSON escapes, throwing getters, content/task/error sentinels absent from metadata and diagnostics. **Validation:** contract test + check. **Checkpoint:** concrete exported types/limits + flags, no runtime dispatch yet. Stop if needed schema cannot represent an operation without promises/provenance Pi lacks; do not weaken the unsupported matrix.

## I3. Bounded idempotency / operation lifecycle

**Depends:** I2. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 20 turns.

**Write scope:** `src/events-requests.ts`, `test/events-requests.test.ts`. No owner wiring/Children calls yet.

Implement injected clock/bus/task dispatch adapters. Key by ownerEpoch/client/request ID; canonical validated semantic fingerprints include operation. Retain bounded acknowledgements/results, 10-minute retry window, 256 records/4 MiB and max16 in-flight. Reject capacity instead of violating retention guarantees. Distinguish accepted/terminal phases, fixed sequence numbers, rejected before acceptance, deadline OUTCOME_UNKNOWN vs cancellation. A deadline must not free a still-mutating operation's concurrency guard or cause retry redispatch. Dispose rejects queued work, ends accepted requests best effort, blocks all stale completions, clears timers/cache. Freeze or clone immutable result DTOs on publication so hostile consumers cannot corrupt dedupe state.

**Tests:** replay during and after completion, conflict across operation/payload, saturation by count/bytes, expiry, timeout + late resolve/reject, promise/callback failure, dispose/reentrant listeners and replacement owner. **Validation:** request+contract tests + check. **Checkpoint:** tracker API and precise terminal semantics. Stop if dispatch cannot be made single-admission under reentrancy.

## I4. Owner metadata, lifecycle and capability composition

**Depends:** I2/I3. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 20 turns.

**Write scope:** `src/owner-events.ts`, minimal `src/agent-status.ts` capability contributor, `src/index.ts` lifecycle/event adapter, `test/owner-events.test.ts`. Read existing Children subscribe/status lifecycle; no changes to raw child registries.

Create a fresh epoch per owner lifetime. Register handlers before status publication, compose one additive integrations section via the existing capability emitter, preserve old fields/order/coalescer/status.observationOnly. Implement generated activity/turn ID through agent_settled, real working/responding/awaiting-input/idle/closing phases, sanitized currentTool and actual pending boolean with queueDepth:null. Add observation-only UI prompt attention IDs/start/end with bounded ambiguity-aware tracking, no titles/options. Attach/dispose owner ready/replay/closing metadata with old owner identity and generation guards. Same-session rebind replays without new subscriptions/epoch. Failed open and remote/join/plain paths cannot advertise ready.

Register strict conversation and attention-reply channels as **rejection-only** using shared validation and fixed UNSUPPORTED_API. No sendUserMessage/sendMessage call or permission/UI interception. Add no fields implying remote input correlation.

**Tests:** fake-clock coalescing and reentrancy, late pings, phase precedence, multi-tool safety, prompt nesting/overflow, no permission/data leak, unsupported zero-dispatch; old status tests preserved. **Validation:** owner+contract+request and existing agent-status unit tests + check. **Checkpoint:** metadata/caps adapter, unsupported gates, owner hook points. Stop if an ordinary event would require queue-depth guesses or attention answers.

## I5. Opt-in output projection and bounded publisher

**Depends:** I4. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 20 turns.

**Write scope:** `src/output-events.ts`, `test/output-events.test.ts`, DTO refinements only when PLAN bounds are unchanged. Read public pi-ai text_delta/message events, not provider internals.

Implement max8 leased subscriptions, ownership/client/subscription validation, subscribe/renew/unsubscribe acknowledgements and bounded resync. Output pure assistant text_delta only; generate message IDs on starts, finalize from allowlisted text blocks even if no delta appeared. Preserve turn/message/sequence correlation. Implement 100ms bounded delta batches, per-event text caps, bounded current/recent snapshots and gap+chunked replacement final reconciliation. Publish fixed completed/failed/aborted activity terminal facts only after settlement; message_end is not activity completion. Never retain raw message objects or serialize reasoning/toolcall/provider errors. Default-off rejects content access.

**Tests:** Unicode/escaping limits, no-subscriber silence, thinking/tool/error sentinels, content-off, no-delta final, multiple assistant messages/retries, late subscription/resync, buffer overflow/gap+final, lease expiry, duplicate subscription/conflict, disposal before timers fire, final text never duplicated by consumer reconciliation. **Validation:** output/contract/request tests + check. **Checkpoint:** output adapter API and precise recovery/truncation semantics. Stop rather than claim full-text/lossless replay beyond caps.

## I6. Real-Pi metadata/output/lifecycle regression tests

**Depends:** I4/I5. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 18 turns.

**Write scope:** narrow `src/index.ts` signal wiring and `test/events-integration.test.ts`; read existing status/headless/session-switch fixtures. Minimal corrections in I4/I5 modules only if needed to match actual public event order.

Bind coordinator to public events with unsubscribe handles; preserve all existing flush/journal/report behavior and ensure nothing publishes after failed open/close. Exercise synthetic provider text deltas, tool calls, aborted/error turns, UI prompts through supported test fixtures, late bridge subscriptions and owner ping. Test existing status caps-before-status plus additive capabilities and turn correlation. Check TUI/RPC owners and existing print/json behavior without changing old status ownership rules; plain/connected/joined sessions remain non-owners. Default-off flags produce no new content/control effects. Test unsupported requests leave input journals/memory untouched and local prompts still journal normally.

**Validation:** integration test + existing agent-status-lifecycle/headless/session-switch tests + check. **Checkpoint:** actual Pi event mapping and targeted results. Stop if tests reveal missing provenance; do not match user text to fake input IDs.

## I7. Existing Children control adapter with race safety

**Depends:** I3/I4/I6. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 20 turns.

**Write scope:** `src/events-controls.ts`, `test/events-controls.test.ts`, minimal coordinator wiring. A narrowly scoped `src/agents.ts` public precondition option is permitted **only** to prevent steer-to-implicit-resume race; no SDK/registry mutation or unrelated refactor.

Implement default-off spawn/steer/stop/resume, max8 spawn batch, explicit model/task/thinking, current owner cwd only, top-level non-connected run ownership, expectedStartedAt and state checks. Reuse Children public methods and existing policy/model/maxAgents/depth/delegation behavior. Inspect `tell`'s pre-await synchronous decision carefully: prevent implicit resume when a steer races with run completion, never call private resume. Use fixed sanitized adapter errors, IDs-only success DTOs and request tracker. Bind generation guard/abort lifecycle across awaits. Stop result documents accepted stop action, not proven run exit. Disabled control must reject before any filesystem/model/memory mutation.

**Tests:** positive each op with fake Children and real fixture where practical; duplicate spawn exactly once, stale owner/run generation, nested/connected rejection, unauthorized cwd, depth/model/capacity policy preservation, steer completion race, timeout then late method settlement, teardown during launch. **Validation:** controls/request/integration tests + existing agents tests where changes warrant + check. **Checkpoint:** operation semantics, any helper change, policy/race results. Stop if an explicit steer cannot be safely separated from resume using a bounded public OptChat helper change.

## I8. Bounded history and selected results

**Depends:** I3/I4/I7. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 18 turns.

**Write scope:** history portion of `src/events-controls.ts`, `test/events-controls.test.ts`, integration read tests. Explore only public sessionManager.getBranch and Children.retained/history metadata.

Implement `recent` current-session-branch tail with <=200 candidate message entries, <=20 items/64 KiB page/16 KiB item, allowlisted user/assistant plain text only. Cache opaque owner/client-scoped cursor snapshots with <=16/512 KiB/60s bounds; reject expired/forged cursors and explicitly indicate truncation. Selected run result validates current profile/run generation, non-connected record, and finalized assistant text projection from retained messages; never publish arbitrary report/error strings. Do not use memory internals or caller paths. Document that public getBranch/retained may copy/read their existing source in full: bounds guarantee new caches/results, not SDK source I/O. If hard source-read limits are required, defer archived run results rather than hand-roll filesystem streaming.

**Tests:** content disabled, exact projection, custom/system/tool/thinking/error/path structural sentinels absent, multibyte/escaping caps, one huge item, cursor ownership/expiry/eviction, stale owner/run, unfinished/final run results, source objects unchanged. **Validation:** controls/integration tests + check. **Checkpoint:** scope/cursors/caps and residual source-read limitation.

## I9. Discord-facing docs / acceptance cross-check

**Depends:** I1–I8. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 12 turns.

**Write scope:** `docs/events-integration.md`, minimal `docs/agent-status.md` and README links, optional small `examples/events-bridge.ts` only if it compiles with current check/build setup; plan progress notes.

Document exact implemented/enabled/unsupported contract, operation/result phases, limits, owner epochs, flags, idempotency deadline uncertainty, stream gaps/final replacement, history scope and attention limitations. Provide a **UI-neutral in-process extension example**, not a Discord bot: subscribe before ping, bind explicit owner, renew/dispose subscriptions, authorize external operations before emitting, filter addressed results, drop stale caches and reconcile output. Clearly state no conversation-submit guarantee or generic remote approval; external bridge owns ACLs, tokens, rate limiting and durable delivery. Preserve existing status observationOnly claim; do not falsely call new content/control metadata observation-only.

**Validation:** doc link/schema/constant cross-check, check/build if code example exists, diff --check. **Checkpoint:** docs match actual capability flags and test behavior; no invented runtime promises.

## I10. Implementation validation and handoff to independent review

**Depends:** I9. **Route:** Implement/MiniMax-M3 Medium. **Budget:** 12 turns. **Write scope:** checklist/results notes only, unless an immediately local validation correction is necessary and recorded.

Run all new event tests, existing status/lifecycle/headless/session-switch/agents regressions, check/full test/build, diff --check with bounded command pattern. Compare baseline; inspect changed files for prohibited scope, dependency/lockfile changes, privacy leaks and unsupported capability advertisements. List each implemented/default-disabled/unsupported family and residual limits. Do not claim completion before independent review. Any new failure stops handoff as not ready; persistent baseline failure is reported with exact unchanged evidence.

**Checkpoint:** changed files, test commands/exits/counts, baseline comparison, API omissions, no commit/push. Parent reviews checkpoint then starts R1, not another implementation child in parallel.

## R1. Independent implementation review

**Depends:** I10. **Route:** reviewer / `openai-codex/gpt-6.1-terra`, **High**. **Budget:** 20 turns. **Read-only scope:** named modules/tests/docs/plans, focused index/Children/status diff and pinned public API evidence.

Audit contract vs actual public APIs; privacy sentinels, explicit opt-ins, unsupported dispatch zero-effects, epoch/lifecycle cleanup, shared-bus trust claims, idempotency/timeout/capacity, race-safe steer vs resume, bounded Unicode output/history, one capability publisher, existing behavior preservation. Run focused tests and check/build; inspect full-suite baseline evidence and reproduce suspicious failures. Review cannot edit or delegate. Return severity-ranked findings with file/line, impact, minimal fix/test, plus acceptance/blockers and test evidence.

**Gate:** parent must receive review before claiming completion. Findings go to F1; no private-API shortcut is an acceptable repair.

## F1. Findings-only repair slice(s)

**Depends:** R1 (or R2 if second and final permitted cycle). **Route:** fixer / `minimax/MiniMax-M3`, **Medium**. **Budget:** 10–20 turns per bounded findings group; one writer.

Parent supplies only review findings and relevant files. Fix smallest supported issue and add regression test; preserve feature scope and existing work. No speculative features/refactors or new model/dependency/API strategy. Run affected tests plus check/build/diff; full suite when shared lifecycle/request primitives change. Hand back exact addressed/unaddressed findings and validation. Stop if the finding requires missing Pi internals or unapproved API semantics; mark capability unsupported instead of faking support and ask parent if scope changes.

## R2. Final independent review / acceptance

**Depends:** R1 + F1 if findings, otherwise R1. **Route:** final reviewer / `openai-codex/gpt-6-luna`, **High**. **Budget:** 18 turns. **Read-only.**

Verify every finding against actual diff and regression tests; check no repair widened scope, changed prior status behavior or leaked text. Run targeted event/lifecycle tests + check/build/diff; evaluate complete baseline/final suite record. Confirm docs/capability omissions explicitly cover strict conversation input, queue depth and attention replies. Return accepted or precise blockers, no edits/delegation/commits. At most one second MiniMax fix -> Luna re-review is allowed; then parent stops/reports if still blocked.

## Completion and final parent report

Acceptance requires feasible families tested and accurately advertised, default-off content/control, unsupported strict conversation/replies documented and side-effect-free, baseline comparison, independent final acceptance, preserved original status implementation, and no commits/pushes/dependency/private-internal/TUI/memory-format changes. Parent reports changed files, event/API matrix, validation results/known baseline failures, privacy and bridge authorization limits, and all deferred roadmap items without calling the entire roadmap implemented.
