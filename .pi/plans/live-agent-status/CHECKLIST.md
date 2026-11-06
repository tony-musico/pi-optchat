# Checklist: live agent status

Source: [PLAN.md](PLAN.md). Objective: observation-only, bounded status events from the profile owner with no existing behavior changes.

## 1. Compatibility gate
- [x] Verify exact pinned Pi 1.4.0 pi.events public API, unsubscribe and dispatch/error semantics.
- [x] Confirm all field sources through existing Children/history/live accessors; no RunHistory/LiveRun internal changes.
- [x] Verify profile/id/model/tool safety and length rules against existing valid values.
- [x] Record baseline check/test/build results; preserve manifest and lockfile.
- [x] Stop/report any mandatory blocker rather than work around it. (No blocker: the bus is public and every field has a safe source.)

## 2. Projection
- [x] Add internal contract constants/types and allowlist projection in src/agent-status.ts.
- [x] Reuse isRunning, isHandingOff, elapsed and history.list ordering.
- [x] Compute full counts, eligible set, cap=64 and omitted consistently.
- [x] Define null/missing-live semantics, tool tie-breaks, timestamps and parent links.
- [x] Test empty/mixed fleets, waiting/stopping/paused/handoff/delivered terminal cases.
- [x] Test cap/overflow/order/nesting/version and string/numeric bounds.
- [x] Seed sensitive task/title/cwd/report/transcript/guidance/tool-args/output strings; prove none reaches serialized payload.
- [x] Prove no source mutation or reference leakage.

## 3. Publisher
- [x] Publish capabilities before initial status; empty fleet included.
- [x] Subscribe once, project latest state only when flushing.
- [x] Bound child-notification and ping replays to one per 250ms.
- [x] Test sustained activity cannot postpone emission indefinitely.
- [x] Test observable changes, unchanged suppression, elapsed-only drift, latest state, reentrancy and final trailing flush.
- [x] Test late-subscriber ping replays capabilities then status without any agent control.
- [x] Test idempotent disposal, listener removal, timer cancellation and stale-callback protection.
- [x] Isolate bus/listener errors without payload logging or changes to agent execution.

## 4. Lifecycle
- [x] Wire only successful owner open; initial publication precedes recovery notifications.
- [x] Repeated same-owner session_start does not create another publisher.
- [x] Dispose at shutdown/profile teardown and failed-open cleanup before closing children.
- [x] Test startup, rebind, switch, shutdown, failed open, and old-owner callback races.
- [x] Verify joined/remote/non-owner paths do not publish.
- [x] Verify headless owner support independent of TUI mount/title subscriptions.

## 5. Documentation and validation
- [x] Add docs/agent-status.md and README link with event/payload/version/bounds contract.
- [x] Document subscribe-before-ping, advertise-before-use, nulls, sampled durations, cap/parent omissions and in-process-only scope.
- [x] Document disposal/stale-cache limitations; no agent control and no title/task/file disclosure.
- [x] Run targeted projection/emitter/lifecycle tests.
- [x] npm run check passes.
- [x] npm test passes (one pre-existing baseline failure in test/agents.test.ts remains; it fails the same way without these changes).
- [x] npm run build passes.
- [x] Review diff: no new runtime dependency, tools/commands, internal state changes, TUI/memory/Agents-page behavior changes, or generated artifacts.
- [x] Deliver changed files, final contract, test outputs/exit codes and deliberate exclusions.

### Checkpoints (from the execution slices)
- **Slice 1 (gate):** pinned Pi 1.4.0 has a public `pi.events` bus (`emit`/`on` with an unsubscribe); it is shared by every extension in one resource loader, so the seam is in-process. Identity formats and their syntax rules verified. Baseline recorded: `npm run check` exit 0, `npm test` exit 1 (383/385 pass, one environment-dependent failure in test/agents.test.ts), `npm run build` exit 0.
- **Slice 2 (projection):** `src/agent-status.ts` with the contract constants, the pure projection and `test/agent-status.test.ts` (22 tests, all pass).
- **Slice 3 (publisher):** the disposable coalescing publisher and its tests in the same file (part of the 22).
- **Slice 4 (lifecycle):** the publisher is attached in `openProfile` after the owner is set up and before recovery, replayed on a same-owner rebind, and disposed at the start of `stop` and in the failed-open cleanup. `test/agent-status-lifecycle.test.ts` (9 tests, all pass) drives the real extension on a real bus.
- **Slice 5 (docs):** `docs/agent-status.md` and the README section.
- **Slice 6 (validation):** see the delivery report; the one failing test is the pre-existing baseline failure, unchanged by this work.

### Review repairs (after the Codex review)
- [x] **Caught error content never reaches a warning.** The publisher's diagnostics are a fixed set of lines; no caught error object is read, so a source, bus or timer error carrying task text cannot reach `ctx.ui.notify` or a log. Regression tests throw a task-content sentinel from the source, the bus and the timer and assert the exact fixed line and no sentinel.
- [x] **A late host is answered.** A host that subscribes after the owner's first publication has nothing until it pings; the ping brings capabilities and then a status, covered by a test that subscribes after the first publication.

## Rollout / rollback
Implement projection → publisher → owner wiring → docs, with tests at each boundary. No migration or feature flag is required. Roll back the publisher attachment and its new module/docs/tests only; no persisted state needs undoing. Preserve unrelated user changes.

## Done
All gate, privacy, lifecycle and validation checks pass, and final evidence is reported. Planning alone does not check off implementation tasks.
