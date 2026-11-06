# Implementation checkpoint — I1 through I10 plus F1 and F2

Date: 2026-11-06

Status: ACCEPTED. The final R2 acceptance pass (`openai-codex/gpt-6-luna`, High, read-only) returned ACCEPT with no remaining findings after F2 corrected the advertised-limit naming defect without changing runtime behavior. No dependency, lockfile, TUI, core, durable, memory-format, prompt, navigation, or settings changes. No commit or push.

## Baseline

- Node `v24.15.0`, npm `11.12.1`.
- `pi-optchat` `0.11.7`; Pi packages pinned to `1.4.0`.
- Baseline `npm run check`, `npm run build`, and `git diff --check` exited 0.
- Baseline full suite: 416 tests, 414 passed, 1 failed, 1 skipped. The reproduced failure is `test/agents.test.ts`'s ambient model-registry expectation; it is not an I1-I8 regression.

## Implemented slices and files

- I1 baseline/public-API evidence: no runtime file changes.
- I2 contracts/flags: `src/events-contract.ts`, `test/events-contract.test.ts`, and the two default-false flag registrations in `src/index.ts`.
- I3 request lifecycle: `src/events-requests.ts`, `test/events-requests.test.ts`.
- I4 owner metadata/lifecycle: `src/owner-events.ts`, `test/owner-events.test.ts`; additive integrations capability contributor in `src/agent-status.ts`; lifecycle/event wiring in `src/index.ts`.
- I5 bounded output: `src/output-events.ts`, `test/output-events.test.ts`; output DTO refinements in `src/events-contract.ts`; owner wiring in `src/index.ts`.
- I6 real-Pi regression coverage: `test/events-integration.test.ts`; narrow lifecycle corrections in `src/index.ts` and the I4/I5 modules only where public event order required them.
- I7 controls: `src/events-controls.ts`, `test/events-controls.test.ts`; owner wiring in `src/index.ts`; a narrow public `allowResume:false` precondition on `Children.tell` in `src/agents.ts`; operation-specific message payload and request-validation refinements in `src/events-contract.ts` and `src/events-requests.ts`.
- I8 bounded history and selected run results: history/result handling in `src/events-controls.ts`; `HistoryRunResultV1` in `src/events-contract.ts`; public `sessionManager.getBranch()` and content-gated owner wiring in `src/index.ts`; unit coverage in `test/events-controls.test.ts`; real-Pi branch and finalized-child reads in `test/events-integration.test.ts`.
- I9 Discord-facing documentation/acceptance cross-check: `docs/events-integration.md`; minimal clarifications in `docs/agent-status.md` and `README.md`. No runtime file was changed in I9.
- I10 implementation validation/review handoff: complete event/status/regression suites, check/full test/build/diff validation, changed-file/dependency/privacy/default-off/unsupported/public-API audits, and this final evidence checkpoint. No runtime file was changed in I10.
- F1 findings-only repair: eight R1 findings fixed in `src/events-requests.ts`, `src/output-events.ts`, `src/events-controls.ts`, `src/events-contract.ts`, `src/index.ts`, `docs/events-integration.md`, and focused tests. No channel rename, refactor, dependency, or unsupported-operation expansion.
- F2 contract-accuracy repair: the obsolete per-second-named limit key was renamed to `queuedDeltaBytes`; the existing 32 KiB per-subscription instantaneous queued-buffer ceiling and all batching/gap behavior are unchanged.

## Decisions

### Request-tracker routing

- Agent controls use the generic bounded request tracker. It supplies owner-epoch/idempotency checks, accepted/terminal phases, deadlines, capacity, replay, conflict, and teardown semantics.
- The tracker gained a synchronous operation-specific `validate` hook so stale/nested/connected/model/capacity checks reject before acceptance and dispatch.
- Owner conversation/attention rejections and output subscribe/unsubscribe/resync acknowledgements remain family-specific paths. Their published envelopes are intentionally different (`EventRequestResultV1` versus `OutputEventV1` acknowledgement kinds). Routing them through the generic tracker would require either publishing an extra generic result on another channel or suppressing tracker results, weakening the documented family contract. They still use the shared allowlisted parser, owner epoch, fixed errors, and family-specific bounded semantics.
- `agent:steer` and `agent:resume` now carry a bounded message in their exact request payload. `agent:stop` remains target/generation only.

### Owner and output semantics

- Request listeners attach before the first capabilities advertisement.
- A same-session rebind replays the same owner epoch without duplicate listeners.
- Failed-open, plain, remote, connected, and joined sessions never advertise owner readiness.
- Main status uses one generated activity turn through settlement, exact public pending state, `queueDepth:null`, sanitized tool names, and anchored 250 ms coalescing.
- Attention is metadata-only and ambiguity-aware; no title, option, answer, permission, or UI interception is published.
- Output is opt-in text only, with bounded leases, 100 ms delta batches, gap/replacement finals, bounded recovery, and settlement-only terminal facts.

### Controls and race safety

- Controls require the independent `--optchat-events-control` consent.
- Spawn requires explicit task/model/thinking, uses the owner cwd, and delegates normal model/depth/maxAgents policy to `Children`.
- Only top-level, non-connected runs owned by the current `Children` instance are controllable.
- `expectedStartedAt` is checked before acceptance and again at dispatch.
- `Children.tell` gained only the narrow public `allowResume:false` precondition. Steer uses it, so a completion race cannot turn into an implicit resume. Resume intentionally uses the existing manager-resume path.
- Stop reports only that stop was requested/awaited, never that the run exited.

### Bounded history and selected results

- `history:recent` and `history:result` use the same generic bounded request tracker as agent controls, on the public history request/result channels. The content flag gates both reads before branch or retained-message access; the control flag continues to gate only agent mutation operations.
- Recent history is the current owner's public `sessionManager.getBranch()` tail. The adapter considers at most 200 message entries and projects only user/assistant text blocks. Custom messages, system/compaction structure, tool results, thinking, tool calls, images, and other roles/blocks are skipped.
- A history item is at most 16 KiB as serialized JSON (including escaping and its identifier), a terminal page result is at most 64 KiB serialized, and a page contains at most 20 items. Truncation, omitted entries, and continuation are explicit in `truncated`, `omitted`, and `nextCursor`.
- Cursors are random, opaque, server-held snapshots scoped to owner session/epoch/client. The cache holds at most 16 snapshots and 512 KiB, expires after 60 seconds, and evicts oldest snapshots when saturated. Forged/expired/evicted cursors return `NOT_FOUND`; foreign owners return `STALE_OWNER`; foreign clients return `POLICY_DENIED`.
- Selected results require a current, exact-generation, top-level, non-connected run. Unfinished runs return safe `ready:false` metadata without reading retained messages. Finalized runs project only the last retained assistant message's text blocks, capped at 32 KiB; `RunInfo.report`, provider/error strings, thinking, tool output, and source metadata are never published.
- Public `getBranch()` and `Children.retained()` may copy or read their existing source in full. The new adapter does not build an unbounded derived source array, but its response/cache bounds do not bound Pi's source I/O. If hard source-read limits are required, archived run results should be deferred rather than implemented with hand-rolled filesystem streaming.
- History remains current-session-branch scoped, not profile-wide OptChat memory history. User/assistant-authored text may naturally contain secrets or paths; content opt-in is consent, not redaction.

### I9 documentation and acceptance boundary

- `docs/events-integration.md` now documents the implemented I1-I8 contract: all literal channels and version-1 payload shapes, independent default-off flags, owner epochs, request phases, idempotency/deadline/capacity behavior, fixed errors, output/attention semantics, agent controls, history/cursors/results, and the public source-read caveat.
- The guide distinguishes the legacy background-agent `status.observationOnly` contract from the separately capability-gated integrations. It does not label content or control as observation-only.
- The Discord boundary is an authorized external bridge over the in-process bus. OptChat ships no Discord transport, credentials, dependencies, remote submission, exact queue depth, generic attention reply, approval simulation, or durable delivery.
- The guide contains a UI-neutral in-process bridge example that binds an explicit owner, subscribes before main-status ping, keeps external authorization in the bridge, filters addressed output/results, shows output lease renewal/unsubscription, and disposes on owner/session shutdown.
- No standalone `examples/events-bridge.ts` was added: the current check/build tsconfigs do not include `examples/`, and adding one would require an out-of-scope config change. The documented TypeScript example was extracted to a temporary file and type-checked cleanly instead.

### F1 findings-only repairs

| Finding | Fix location | Repair |
| --- | --- | --- |
| H1 | `src/events-requests.ts:246-278,470-476` | Expired unsettled mutations are no longer purged or rescheduled. Their record, uncertainty guard, in-flight slot, and retained bytes remain until the underlying operation settles; settlement then removes the expired record and frees capacity. |
| M1 | `src/output-events.ts:74-86,271-279,340-391,466` | Each queued subscription batch now carries its source `turnId`/`messageId`. A batch from a different assistant message is cleared with a gap instead of being mixed. |
| M2 | `src/events-controls.ts:533-568` | Deferred continuation items are no longer counted as omitted. `omitted` now means permanently unavailable snapshot entries; `truncated` means actual text/entry loss rather than mere continuation. |
| M3 | `src/index.ts:374-379` | A failed open after readiness now disposes the owner with announcement enabled, producing a matching closing event for the same session/epoch before listeners are removed. |
| M4 | `docs/events-integration.md:447-464` | The bridge example retains a pending request through `accepted`, checks owner session/epoch, and removes the ID only on terminal `completed` or `rejected`. |
| M5 | `src/output-events.ts:155-193` | Assistant text blocks are appended incrementally to the 128 KiB retained-message cap. The full oversized concatenation is no longer assembled, and truncation stays on a Unicode code-point boundary. |
| L1 | `src/events-contract.ts:628-639` | The documented explicit `attention:reply` payload with `answer:null` now parses successfully and reaches the existing zero-effect `UNSUPPORTED_API` gate. |
| L2 | `src/events-contract.ts:162-175` | `requestChannel('output:unsubscribe')` now returns `OUTPUT_UNSUBSCRIBE_EVENT`; every supported and unsupported operation's request/result mapping is checked against the documentation. |

F1 regression names:

- `test/events-requests.test.ts`: `an unsettled timed-out mutation keeps its slot and uncertainty guard beyond the retry window`.
- `test/output-events.test.ts`: `queued deltas keep the turn and message ids of their authoritative finals`; `oversized Unicode text blocks are retained incrementally within the byte cap`.
- `test/events-controls.test.ts`: `history continuation does not count deferred items as omitted`.
- `test/events-integration.test.ts`: `a failed open after owner publication emits a matching closing and removes listeners`; `the documented bridge handler keeps accepted requests pending until a terminal result`.
- `test/events-contract.test.ts`: `the documented operation table matches the exact request and result channel mapping`.
- `test/owner-events.test.ts`: the existing zero-effect rejection test now sends the documented explicit-null attention reply payload.

### F2 contract-accuracy repair

R2 accepted all eight F1 repairs and found exactly one acceptance defect: the obsolete per-second-named limit key advertised a per-second budget, while the implementation only enforces an instantaneous per-subscription queued-delta buffer ceiling.

F2 changed only the advertised name and its documentation:

- `src/events-contract.ts`: `EVENT_LIMITS.queuedDeltaBytes = 32768`; the obsolete key is absent.
- `src/output-events.ts`: the existing `MAX_QUEUED_DELTA_BYTES` value is now sourced from `EVENT_LIMITS.queuedDeltaBytes`; it remains 32768 and all batching, flush cadence, gap, and overflow behavior is unchanged.
- `test/events-contract.test.ts`: the exact limits expectation uses `queuedDeltaBytes`; a new regression proves the capability exposes `queuedDeltaBytes` and no per-second key.
- `test/output-events.test.ts`: the existing overflow-gap test now exceeds the advertised 32768-byte per-subscription buffer ceiling exactly and still proves a gap is emitted.
- `docs/events-integration.md` and `.pi/plans/events-integration/PLAN.md`: state that queued delta bytes buffered per subscription are at most 32768 (32 KiB), flushing occurs at most once per subscription per 100 ms, and no per-second throughput/token budget is advertised or enforced; throughput is bounded by producer input.
- `.pi/plans/events-integration/CHECKPOINT.md`: records the corrected limit and F2 evidence.

F2 regression name: `the capability publishes the queued delta buffer ceiling without a per-second budget`.

No runtime rate limiter, token bucket, timer, batching change, gap change, dependency, or public operation change was added. A repository-wide grep finds no remaining obsolete key occurrence.

### Final family inventory

| Family | Final state | Consent / boundary |
| --- | --- | --- |
| Background-agent status/capability/ping | Implemented, observation-only | Metadata; no content or control. Legacy 64-agent/250 ms snapshot limits remain. |
| Owner lifecycle, main status, attention observations | Implemented | Metadata enabled; no prompt/option/answer/permission content. |
| Assistant output subscribe/unsubscribe/resync | Implemented, default-disabled | Requires `--optchat-events-content`; text only. |
| Agent spawn/steer/stop/resume | Implemented, default-disabled | Requires `--optchat-events-control`; exact owner/run generation and normal Children policy. |
| Recent current-session-branch history | Implemented, default-disabled | Requires `--optchat-events-content`; current branch only. |
| Selected finalized run result | Implemented, default-disabled | Requires `--optchat-events-content`; exact-generation top-level non-connected run, assistant text only. |
| Conversation submit/queue/steer | Unsupported | Valid requests return `UNSUPPORTED_API`; zero input/memory/permission dispatch. |
| Attention reply | Unsupported | Valid requests return `UNSUPPORTED_API`; no UI/permission interception. |
| Exact queue depth | Not available | Always `queueDepth:null`, `exactQueueDepth:false`. |
| Approval simulation / generic remote approval | Not available | No operation exists; approval policy is never bypassed. |
| Discord/cross-process transport, durable delivery | Not shipped | An external authorized bridge may use the in-process bus; OptChat ships no transport or credentials. |

### Advertised limits and residual limitations

- Request parsing/admission: `executableStringBytes:65536`, `inputTextBytes:32768`, `spawnTasks:8`, `inFlightRequests:16`, `idempotencyRecords:256`, `retainedResultBytes:4194304`, `retryWindowMs:600000`, `operationDeadlineMs:30000`.
- Metadata: `metadataCoalesceMs:250`; legacy background status remains at most 64 rows. Main status is replaceable, not a lossless log; `queueDepth` remains unknown.
- Output: `outputSubscriptions:8`, `retainedMessageBytes:131072`, `retainedMessages:16`, `recoveryCacheBytes:524288`, `outputEventBytes:8192`, `outputBatchIntervalMs:100`, `queuedDeltaBytes:32768`; `queuedDeltaBytes` is the instantaneous per-subscription queued-delta buffer ceiling, not a per-second throughput budget. Leases last five minutes and must be renewed. Recovery is bounded, not lossless; final text replaces accumulated deltas.
- History: `historyItems:20`, `historyPageBytes:65536`, `historyItemBytes:16384`, `historyCandidates:200`, `historyCursors:16`, `historyCursorBytes:524288`, `historyCursorTtlMs:60000`, `runResultTextBytes:32768`.
- Owner epochs change on owner replacement; closing is best effort and process death may publish nothing. A later initialization failure after readiness publishes a matching closing for that owner before removing listeners. The event bus is in-process, non-durable, has no network backpressure, and does not authenticate extensions.
- Content opt-in is consent, not redaction: user/assistant-authored text may naturally contain secrets or paths. History is not profile-wide memory.
- Public `getBranch()` and `Children.retained()` may read/copy their existing source in full. The new result/cache bounds do not bound Pi source I/O; hard source-read requirements would require deferring archived results.
- The `30s` deadline produces `OUTCOME_UNKNOWN`; a dispatched mutation retains its slot until the underlying method settles, and a late terminal result is suppressed. A timeout is not proof of non-execution.
- Spawn/stop/resume retain normal Children model, auth, cwd, depth, max-agent, ownership, and state policy. Stop means stop was requested/awaited, not that the run exited.
- Attention is ambiguity-aware metadata only. Main status and attention never publish titles, options, answers, permission decisions, or UI handles.

### Changed-file boundary

`git status --short --untracked-files=all` reports exactly 26 files:

| File | Purpose |
| --- | --- |
| `README.md` | User-facing status/integration documentation and links. |
| `src/agents.ts` | Narrow public `Children.tell({allowResume:false})` precondition only. |
| `src/index.ts` | Owner wiring, default-off flags, lifecycle hooks, and public branch injection. |
| `.pi/plans/events-integration/PLAN.md` | Settled event-integration goals, contract matrix, and constraints. |
| `.pi/plans/events-integration/EXECUTION_PLAN.md` | Ordered I1-I10 implementation and review route. |
| `.pi/plans/events-integration/CHECKLIST.md` | Per-slice completion checklist through I10. |
| `.pi/plans/events-integration/CHECKPOINT.md` | Implementation, F1/F2 repairs, validation, audit, and final R2 handoff evidence. |
| `.pi/plans/live-agent-status/PLAN.md` | Earlier bounded background-agent status design/evidence. |
| `.pi/plans/live-agent-status/EXECUTION_PLAN.md` | Earlier status implementation sequence and gates. |
| `.pi/plans/live-agent-status/CHECKLIST.md` | Earlier status implementation/validation record. |
| `docs/agent-status.md` | Authoritative legacy background-agent status contract. |
| `docs/events-integration.md` | Implemented I1-I8 event contract and Discord bridge boundary. |
| `src/agent-status.ts` | Bounded background-agent status projection/publisher. |
| `src/events-contract.ts` | Literal channels, envelopes, flags, limits, operations, and fixed errors. |
| `src/events-requests.ts` | Parsing, idempotency, deadlines, capacity, and request lifecycle. |
| `src/owner-events.ts` | Owner/main/attention metadata and unsupported rejections. |
| `src/output-events.ts` | Opt-in bounded assistant output and recovery. |
| `src/events-controls.ts` | Authorized controls, bounded history, cursors, and selected results. |
| `test/agent-status.test.ts` | Status projection/publisher unit and sentinel coverage. |
| `test/agent-status-lifecycle.test.ts` | Real owner lifecycle and non-owner regression coverage. |
| `test/events-contract.test.ts` | Exact DTO/channel/flag/limit/error contract tests. |
| `test/events-requests.test.ts` | Idempotency, deadline, capacity, teardown, and replacement tests. |
| `test/owner-events.test.ts` | Owner/main/attention metadata and zero-effect rejection tests. |
| `test/output-events.test.ts` | Output privacy, streaming, recovery, lease, and settlement tests. |
| `test/events-controls.test.ts` | Control/history/cursor/result policy, bound, privacy, and immutability tests. |
| `test/events-integration.test.ts` | Real-Pi lifecycle and end-to-end event integration coverage. |

No `package.json`, lockfile, TUI, core, durable, memory-format, prompt, navigation, or settings-schema file is changed.

## Final validation table

| Validation | Tests | Passed | Failed | Skipped | Exit | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Accepted F1 baseline full suite | 502 | 500 | 1 | 1 | 1 | Known ambient model-registry baseline failure only. |
| F2 required event + status/lifecycle suites | 118 | 118 | 0 | 0 | 0 | All passed. |
| F2 background `timeout 180s npm test` | 503 | 501 | 1 | 1 | 1 | One new F2 contract test passed; only the known baseline failure. |
| F2 documentation/contract cross-check | n/a | n/a | n/a | n/a | 0 | 18 channels, 11 envelopes, 2 flags, 24 limits including `queuedDeltaBytes`, 13 errors, 13 operations, all request/result mappings, explicit-null attention payload, and 29 links matched/resolved. |
| `timeout 55s npm run check` | n/a | n/a | n/a | n/a | 0 | Passed. |
| `timeout 55s npm run build` | n/a | n/a | n/a | n/a | 0 | Passed. |
| `git diff --check` | n/a | n/a | n/a | n/a | 0 | Passed. |

The sole failure in the F2 full suite is the unchanged `test/agents.test.ts` ambient model-registry assertion. **No new failure was introduced. F2 is READY for final R2 acceptance, not yet independently accepted.**

## I10 audit evidence

### Privacy and publication boundary

```sh
grep -nE '\b(err|error|cause)\.(message|stack)\b|String[[:space:]]*\([[:space:]]*(err|error)\b' src/events-contract.ts src/events-requests.ts src/owner-events.ts src/output-events.ts src/events-controls.ts src/agent-status.ts
# NO_MATCHES

grep -nE '\.report\b|RunInfo\.report' src/events-contract.ts src/events-requests.ts src/owner-events.ts src/output-events.ts src/events-controls.ts src/agent-status.ts
# NO_MATCHES

for type in StatusV1 StatusAgentV1 StatusCountsV1 StatusCapabilitiesV1 IntegrationsCapabilityV1 MainStatusV1 OwnerEventV1 AttentionEventV1 OutputEventV1 HistoryPageV1 HistoryItemV1 HistoryRunResultV1 EventRequestResultV1; do awk -v t="$type" '$0 ~ "export interface " t " " {p=1} p{print} p && /^}/ {exit}' src/events-contract.ts src/agent-status.ts; done | grep -nE 'readonly (task|title|transcript|path|prompt|workingDirectory|sessionFile)\b'
# NO_MATCHES
```

Metadata snapshots therefore contain no structural task/title/transcript/path fields. Opt-in history/output text can still contain user/assistant-authored text, which the content flag does not redact.

The new event-publication modules contain no raw error access. The legacy `src/index.ts` UI diagnostic helper still uses `error.message`/`String(error)` for its pre-existing on-screen/stderr diagnostics; comparison with `HEAD` shows that helper and its uses predate this work and are outside the event-bus snapshot payloads. This remains an existing legacy diagnostic privacy limit rather than new event leakage.

### Default-off and zero-effect behavior

```sh
grep -nE 'registerFlag\(EVENTS_(CONTENT|CONTROL)_FLAG.*default: false' src/index.ts
# lines 126-127: both flags default false

grep -nE 'operationNeedsContent|operationNeedsControl|contentEnabled !== true|controlEnabled !== true' src/events-requests.ts
# content gate at 342; control gate at 345

grep -n '!options.contentEnabled' src/output-events.ts
# output delta/request/final/settlement paths all gate content

sed 's://.*::' src/owner-events.ts | grep -nE '\b(sendMessage|sendUserMessage|setPrompt|approve|permission|answer|queue|steer)[[:space:]]*\('
# NO_MATCHES
grep -nE '\b(ctx|pi)\.' src/owner-events.ts
# NO_MATCHES

grep -nE 'queueDepth: null|exactQueueDepth: false' src/events-contract.ts src/owner-events.ts
# both enforced as null/false
```

Focused tests passed in the 117-test F1 command: disabled control performs no child/model/filesystem work; content-disabled history performs no branch/retained read; content-off publishes no assistant text; the default capability reports both integrations disabled; valid conversation/attention requests have zero dispatch and leave local journaling untouched.

### Public API seams

```sh
grep -nE 'getBranch\(|retained\(' src/index.ts src/events-controls.ts src/agents.ts
# index injects ctx.sessionManager.getBranch(); adapter calls options.children.retained; Children.retained is public

grep -nE '^  async (spawn|tell|stop)\(|^  retained\(' src/agents.ts
# public Children spawn/tell/stop/retained methods

grep -nE 'allowResume' src/agents.ts src/events-controls.ts
# only the narrow public Children.tell allowResume:false precondition and steer use

grep -n '@earendil-works/pi-coding-agent' src/events-controls.ts src/owner-events.ts
# NO_MATCHES
grep -nE 'as any|sessionManager\.getEntries|session\.messages|\.registry\b' src/events-controls.ts src/owner-events.ts src/output-events.ts
# NO_MATCHES
```

The adapters touch no private Pi SDK state and do not hand-roll transcript/filesystem reads.

## F2 to final R2 acceptance handoff

R1 (`openai-codex/gpt-6.1-terra`, High) returned BLOCK with eight findings. F1 addressed exactly those findings. R2 (`openai-codex/gpt-6-luna`, High) accepted all eight F1 repairs and found exactly one remaining acceptance defect: the obsolete per-second-named limit key misstated the implemented instantaneous per-subscription buffer ceiling as a per-second budget.

F2 changed only that contract name and its documentation. No runtime behavior changed. The final R2 acceptance pass starts only after the parent accepts this F2 checkpoint. Route remains `openai-codex/gpt-6-luna`, High, read-only, with no edits or delegation.

Final R2 scope and mapping:

- Verify the capability limits object exposes `queuedDeltaBytes: 32768` and no per-second key.
- Verify `src/output-events.ts` still enforces the same 32 KiB per-subscription instantaneous queued-buffer ceiling, with the same 100 ms flush cadence and gap-on-overflow behavior.
- Verify docs and the plan no longer claim a per-second throughput/token allowance and state that throughput is bounded by producer input.
- Reconfirm the eight accepted F1 repairs and their regressions, privacy/default-off/unsupported-zero-dispatch/public-API boundaries, the unchanged 26-file boundary, dependency/lockfile state, and HEAD.
- Rerun the 118-test targeted suite, check, build, diff validation, docs/contract cross-check, and the full suite; confirm the known ambient model-registry failure is the only failure.

Final R2 must return an explicit ACCEPT/BLOCK verdict with command evidence and residual risk. This is fix cycle 2 of 2 and the final permitted review cycle; unresolved findings return to the operator rather than opening another implementation loop.

## Final R2 acceptance (2026-11-06)

Reviewer: `openai-codex/gpt-6-luna`, High, read-only. Verdict: **ACCEPT**, no remaining findings.

Verified independently by the reviewer:

- **Runtime unchanged by F2.** `EVENT_LIMITS.queuedDeltaBytes` is still 32768 and `MAX_QUEUED_DELTA_BYTES` aliases it; the output path still caps each subscription's queued buffer at 32768 bytes, flushes at most once per 100 ms, and clears/coalesces with a `gap` on overflow. No rate limiter, token bucket, or per-second window was introduced.
- **No stale claims.** No `queuedDeltaBytesPerSecond` references remain; per-second statements about the output budget explicitly deny such a budget, and remaining rate-limit mentions concern unrelated provider or Discord-bridge limits.
- **Consistency.** `integrationsCapabilities` exposes `EVENT_LIMITS`; the documentation table matches the exposed names and values; README and `docs/agent-status.md` contain no contradicting claims.
- **All eight F1 repairs re-verified:** mutation uncertainty guard retained past the retry window, delta `turnId`/`messageId` correlation IDs, history pagination counts (omitted vs deferred), failed-open readiness cleanup, bridge `accepted` vs terminal handling, bounded text projection, nullable attention answer, and `output:unsubscribe` channel mapping. Relevant regressions passed.
- **Safety.** Content and control flags remain registered default-off; unsupported conversation and attention operations reject before dispatch; privacy scans found no raw error-message/stack or report leakage in the touched modules. The only intended public API change is backward-compatible `Children.tell(..., {allowResume?: boolean})`.
- **Boundary.** Exactly 26 changed/untracked files; HEAD `57986e3102b42a089dba00ca20b2c1884350b7ef`; dependency and lockfiles unchanged; no prohibited-scope edits. The reviewer modified no files.

Validation evidence: `npm run check`, `npm run build`, and `git diff --check` passed. Targeted suites 118 passed / 0 failed. Full uncropped `npm test`: 503 total, 501 passed, 1 failed, 1 skipped — the single failure is the known ambient model-registry assertion in `test/agents.test.ts`, not a regression of this work.

Loop closed at two fix/review cycles (F1, F2). The work remains uncommitted by design; committing, pushing, and any Discord delivery remain operator decisions outside this loop's scope.
