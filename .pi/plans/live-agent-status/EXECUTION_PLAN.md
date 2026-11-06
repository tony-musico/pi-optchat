# Execution plan: live agent status

Sources: [PLAN.md](PLAN.md), [CHECKLIST.md](CHECKLIST.md).

## Rules and routing
Execute ordered slices, one writer per worktree. This document does not authorize launching subagents; obtain operator authorization before delegation. Use route `implementor` for steps 1–5 and `micro-worker` for step 6. Model/thinking: leave unset on every slice (current profile default); do not hardcode models from skill templates or choose alternatives without a user request. Every slice is bounded to 10–20 turns; stop at its checkpoint instead of expanding into another slice. If it cannot fit, hand back the blocker and split it.

Pass only these plan files and the preceding concise handoff: changed files, decisions, validation command/exit/result, unresolved blockers. Never forward a transcript or raw large output. Do not commit/push without authorization. Preserve unrelated edits. Use bounded commands; save full logs to temporary files, report exit code and last <=60 lines. No polling/waiting for slow background work. If a validation exceeds its timeout, report incomplete instead of claiming failure-free success or repeatedly waiting.

Global stop conditions: pinned Pi lacks pi.events; exposing state requires RunHistory/LiveRun internal changes; allowlist projection cannot exclude task text. Also stop if public API/lifecycle safety cannot meet the settled contract without widening scope. Do not invent transports, state helpers or unsafe fallbacks.

## 1. Verify public seam and settle integration mapping
**Goal:** validate prerequisites before code. **Dependencies:** none. **Budget:** 15 turns.

Scope: package.json/package-lock.json, exact pinned Pi ExtensionAPI/event bus declarations and implementation, src/index.ts owner lifecycle, src/agents.ts public read accessors, src/runs.ts helpers, src/inspector.ts elapsed, installed pi-subagents docs/extension-api.md sections on ping/events. Do not recursively inspect unrelated modules.

Actions:
1. Inspect working tree. If dependencies absent, use a bounded lockfile-preserving install (`timeout 120s npm ci --ignore-scripts`); do not upgrade versions. Stop/report inability to obtain exact pinned types.
2. Confirm emit/on/unsubscribe and synchronous/asynchronous error behavior in the pinned API. Confirm any peer-range limitation without altering the range.
3. Verify safe profile/id sources and practical field bounds; map currentTool, elapsed and lastActivityAt without parsing transcripts. Confirm RunHistory/LiveRun remain read-only.
4. Locate exact attach/dispose points including duplicate same-session rebind, failed initialization, remote/join and headless cases. Settle the plan's adapter interface from actual SDK types, not casts.
5. Capture bounded baseline `timeout 120s npm run check`, `timeout 180s npm test`, `timeout 120s npm run build` (separate logs). Baseline failures block a clean final claim; report environment blockers rather than silently repairing unrelated code.

Deliverable/checkpoint: prerequisite evidence and concise final mapping; update PLAN.md only if a compatible refinement is necessary. No runtime edits. Validation: all gate questions answered and manifest/lockfile unchanged. Stop on any global blocker or unsafe required identity source.

## 2. Implement and unit-test pure projection
**Goal:** one privacy-safe DTO implementation. **Depends on:** 1. **Budget:** 20 turns.

Scope: new src/agent-status.ts, new test/agent-status.test.ts. Read only the named helpers/accessors as necessary; do not change src/runs.ts, Children or LiveRun internals.

Actions:
1. Add literal event constants, v1 DTOs and explicit field bounds. Follow PLAN.md counts, eligibility, source ordering and cap exactly.
2. Implement projection using existing helpers, supplied sampled clock, history.list and live(id). Explicitly pick fields; omit titles entirely. No transcript/message/file reads or object spreads from source state.
3. Add tests for empty/mixed fleets, all active states, pause/handoff/delivered terminal exclusion, nested ordering and missing live data. Test >64 entries and counts before cap, tie-breaks, null model/tool, finite values and all string limits.
4. Add sensitive-sentinel and exact-key tests at every DTO level; include task, title, file paths, report, guidance, transcript, tool args/output. Assert no source mutation and emitted objects share no mutable source containers.

Validation: `timeout 120s npx --no-install tsx --import ./test/support.ts --test test/agent-status.test.ts`; `timeout 120s npm run check`. Capture exits and <=60 log lines. Checkpoint: projection API, field mapping, files/tests, any unresolved issue; no publisher/lifecycle work in this slice.

## 3. Implement disposable coalescing publisher and unit tests
**Goal:** deterministic bounded event delivery, independent of owner wiring. **Depends on:** 2. **Budget:** 20 turns.

Scope: src/agent-status.ts and test/agent-status.test.ts; actual pinned bus type learned in 1. No src/index.ts edits yet.

Actions:
1. Add a small bus/clock/scheduler adapter compatible with the actual API. Keep injected test fakes deterministic; no new dependencies.
2. Subscribe before initial sample. Emit capabilities then initial status, including zero fleet. Normal changes and observation-only ping use one 250ms anchored coalescer, projecting latest state at flush. No interval or per-notification fleet scan.
3. Compare semantic payloads without sampledAt/elapsed-only drift; pings force a bounded advertise/status replay. Handle reentrant notification without recursive emission/lost dirty state.
4. Implement idempotent disposal, unsubscribe both listeners, timer cancellation and stale owner/disposal guards. Isolate bus errors based on verified API semantics, warning without payload and without warning storms.
5. Test emitted changes, latest-state coalescing, sustained activity, minimum interval, unchanged suppression, replay ordering, no ping control effects, reentrancy, disposal before flush and stale callbacks. Test consumer mutation cannot affect source state and throwing listeners cannot break agent execution.

Validation: same bounded targeted test command and check as step 2. Checkpoint: publisher API, scheduling semantics, failure behavior, tests/exits and files only. Stop if actual SDK semantics make error isolation impossible without unrelated behavior changes.

## 4. Wire owner lifecycle and regression tests
**Goal:** correct owner-only publication through real lifecycle. **Depends on:** 3. **Budget:** 20 turns.

Scope: src/index.ts; new test/agent-status-lifecycle.test.ts and narrowly necessary fixture reuse from test/session-switch.test.ts, test/headless.test.ts, test/reopen.test.ts. Leave memory/navigation/inspector/Agents-page code unchanged.

Actions:
1. Store one publisher disposer beside existing owner lifecycle disposers. Attach after successful owner setup and before recovery starts. No TUI condition; do not attach in remote/join paths.
2. Handle repeated same-owner start as bounded replay with no duplicate subscription. Dispose at the start of teardown before async close, during profile switch, and in failed-open cleanup.
3. Add real-extension tests observing the bus: initial empty fleet, child transition, same-session rebind, headless ownership, shutdown, profile replacement, initialization failure, stale old-owner callback, and non-owner joined/remote absence. Assert capabilities-before-status in all publication paths.
4. Verify only observational calls were added: no calls to spawn/tell/stop from event handlers and no existing lifecycle/UI outputs changed.

Validation: `timeout 120s npx --no-install tsx --import ./test/support.ts --test test/agent-status*.test.ts test/session-switch.test.ts test/headless.test.ts test/reopen.test.ts`; `timeout 120s npm run check`. Checkpoint: lifecycle attach/dispose points, regression results, files and blockers. If fixture work exceeds budget, return a bounded follow-up rather than omit coverage.

## 5. Document contract and review privacy/conformance
**Goal:** host authors can use the seam without implementation imports. **Depends on:** 4. **Budget:** 12 turns.

Scope: new docs/agent-status.md, README.md link; read src/agent-status.ts and its tests, review diff only. No runtime feature additions.

Actions:
1. Document exact event names, payload fields/nulls, state/count meanings, 64-row and string bounds, ordering, parent omissions, versions and ignorable unknown fields.
2. Include a minimal host example: subscribe to capabilities/status, emit read-only ping, verify version/capability, replace snapshot keyed by profile+owner, display counts, and dispose subscriptions. No import from OptChat, tools, polling, file reads or agent controls.
3. Explain same-process-only scope, owner vs connected-window distinction, sampled durations, coalescing and missing intermediate transitions, and shutdown/abrupt-exit cache limitations.
4. Audit field allowlist and sensitive-sentinel coverage; explicitly list title/task/path omission and no changes to existing UI/memory/tools. Confirm advertised capabilities match actual supported fields.

Validation: targeted status test command from step 2 and `git diff --check`; inspect docs example against pinned bus API. Checkpoint: final contract, documentation paths and privacy review findings. Stop/report if docs would need to claim unsupported behavior.

## 6. Full validation and delivery
**Goal:** completion evidence, not new feature development. **Depends on:** 5. **Budget:** 10 turns.

Scope: repository diff, package scripts, tests and planning checklist. Agent route micro-worker; model/thinking unset.

Actions:
1. Run separately with captured logs: `timeout 120s npm run check`, `timeout 180s npm test`, `timeout 120s npm run build`.
2. Capture command, exit code, pass/fail counts and brief output. A timeout is incomplete; don't retry indefinitely or mask errors with a successful tail command. Stop/report implementation failures with the smallest reproducible test for a separate corrective slice.
3. `git diff --check`; inspect `git status --short` and diff scope (including new files). Confirm no package/lock changes, new runtime dependencies, exports/build-root edits, new tools/commands, forbidden internal edits, or unrelated generated artifacts.
4. Update CHECKLIST.md only for proven complete items. Report changed files, exact final event contract, full validation outputs, compatibility caveats, and deliberate exclusions. Do not imply baseline defects were fixed if not addressed.

Completion checkpoint: required checks all pass, no existing behavior regressions, bounds/privacy and owner teardown covered, docs complete. If any requirement remains unmet, return an explicit incomplete report rather than shipping a guessed contract.

## Checkpoints (what each slice found and did)

### 1. Verify public seam and settle integration mapping
The pinned 1.4.0 package is installed and unchanged. `pi.events` is `ExtensionAPI.events: EventBus` with `emit(channel, data)` and `on(channel, handler) => unsubscribe`; the bus is shared by every extension one resource loader loads, and `pi.events.emit` throws once the extension is stale, so every emit is guarded. No blocker. Baseline: `npm run check` exit 0, `npm test` exit 1 (383 pass, 1 fail, 1 skipped; the failure is `test/agents.test.ts` expecting only test models in `models()`, which this machine's real model registry breaks), `npm run build` exit 0.

### 2. Implement and unit-test pure projection
`src/agent-status.ts` holds the contract constants, the types and the projection; `test/agent-status.test.ts` covers the fleet cases, the cap, ordering, nesting, tool tie-breaks, null semantics, the bounds, the sensitive-sentinel proof and the no-mutation proof. 20 tests pass with the file's publisher tests included.

### 3. Implement disposable coalescing publisher and unit tests
The publisher takes the bus, a source, a clock and a timer, so it is deterministic under test. It publishes capabilities before the first status, coalesces changes into one 250 ms window anchored to the last publication, suppresses identical snapshots, replays on a ping, and disposes idempotently without leaving a timer behind.

### 4. Wire owner lifecycle and regression tests
The publisher is created in `openProfile` after the owner is set up and before recovery starts, replayed (never re-created) when the same owner binds again, and disposed at the start of `stop` and in the failed-open cleanup. `test/agent-status-lifecycle.test.ts` runs the real extension on a real bus: first publication, a spawned child appearing, a ping, a same-owner rebind, a shutdown, a session that owns nothing and a session that joins another Pi.

### 5. Document contract and review privacy/conformance
`docs/agent-status.md` and a README section. The documented example uses only `pi.events` and the extension API; it polls nothing, reads no file and calls no agent.

### 6. Full validation and delivery
See the delivery report. The failing test is the pre-existing baseline failure; nothing in this change touches models, tools or the memory path.

### 7. Review repairs (Codex review, medium finding)
The Codex review found that the publisher put a caught exception's message into a warning, and that warning reaches `ctx.ui.notify`. An exception from the run source, the event bus or the timer can carry task text, a path or a bus payload, so that was a real leak path.

Repairs, all inside the status module and its tests:
- Every catch site now reports a fixed line naming the category that failed ("the event bus refused the message", "the agents could not be read", "the status could not be built", "the status could not be scheduled", "the profile or session identity is not publishable", "an agent identity is not publishable", "OptChat could not watch its agents.", "OptChat could not answer a status ping."). No caught error object is read anywhere in the module.
- The source read is wrapped on its own, so a failure there is reported as "the agents could not be read" rather than as a generic publication failure, and the scheduler is wrapped on its own for the same reason.
- Regression tests throw a task-content sentinel from the source, from the bus and from the timer, and assert the exact fixed line and that the sentinel appears nowhere in the warnings; a lifecycle test drives the same leak through a real owner and asserts the screen (the `ctx.ui.notify` notes) never shows the sentinel.
- A fresh late consumer is now covered explicitly: a host that subscribes after the owner's first publication has nothing, pings, and receives capabilities and then a status.
