# Plan: capability-gated Pi events integrations

## Problem and goal

Implement the **public-API-feasible portions** of `docs/events-integration.md` for a trusted, in-process UI/Discord bridge. Preserve the existing background-status API and all uncommitted work. Do not represent the entire roadmap as available: pinned Pi 1.4.0 cannot provide strict conversation delivery correlation or generic UI-prompt replies.

The deliverable is a tested, UI-neutral metadata/content/control contract, explicit unsupported capabilities, updated integration guidance, and no Discord transport dependency. All new content and mutations require separate process-level opt-ins. This is not authorization to bypass Pi policies.

## Current state and inspected evidence

- Package: `pi-optchat` 0.11.7, Node >=22.19, pinned installed `@earendil-works/pi-coding-agent`, pi-agent-core and pi-ai **1.4.0**. No dependency change needed.
- Preserve tracked edits `README.md`, `src/index.ts`; untracked `.pi/`, `docs/agent-status.md`, `docs/events-integration.md`, `src/agent-status.ts`, and both agent-status test files. These are prior work, not disposable scaffolding.
- `src/agent-status.ts` owns capabilities/status/ping, an anchored 250ms coalescer, fixed diagnostics and disposable listeners. `src/index.ts` attaches after profile initialization, disposes at stop/failed open, and replays on same-session rebind.
- `src/index.ts` handles `input`, `before_agent_start`, `agent_start`, `message_end`, `turn_end`, `agent_settled`; journals inputs through `Inbox` and logs to profile memory. Its extension-source input is intentionally journaled later at `message_end`.
- `Children.spawn`, `tell`, `stop`, `history.records/list`, `live` are existing OptChat seams. `tell` can implicitly resume finished manager runs; adapters must prevalidate operation/state, not expose implicit steer-to-resume behavior. Existing launch/resume enforce models, auth, maxAgents, depth, ownership and shutdown constraints.
- Pi public declarations: `dist/core/extensions/types.d.ts` exposes `message_start/update/end`, tool start/end, `ui_prompt_start/end`, `agent_settled`, read-only `sessionManager.getBranch`, `isIdle`, and **boolean** `hasPendingMessages`. Event registrations return unsubscribe.
- Public EventBus: `emit(channel, unknown): void`, `on(channel, handler): () => void`. Installed implementation invokes listeners immediately via an async error-catching wrapper; it is not durable, awaited, transactional or an authentication boundary. Own callbacks must catch internally to avoid Pi logging arbitrary errors.
- **Blocker evidence:** `ExtensionAPI.sendUserMessage` returns **void**. `agent-session.js` bindCore wraps the asynchronous call and sends failures to runtime error notices; no public preflight result, queue-item ID, or provenance token is available to ordinary event handlers. `ReplacedSessionContext.sendUserMessage: Promise<void>` exists only during session replacement and is not a general-purpose escape hatch. Input can be transformed/handled by other extensions. Do not infer accepted/delivered messages by matching text or timestamps.
- **Blocker evidence:** `UIPromptStart/EndEvent` has kind/title only, no answer function, stable ID, options, permission decision or expiry handle. `ExtensionContext` has no exact queue-depth getter. No private fields, runner rebinding, raw AgentSession capture or UI interception is permitted.

This planning phase inspected source/types; it did not run runtime validation. Earlier reported full-suite failure in `test/agents.test.ts` is a baseline claim to reproduce, not permission to ignore new failures.

## Feasibility / channel contract matrix

| Family / channels | Deliverable against Pi 1.4.0 |
| --- | --- |
| Existing `optchat:capabilities:v1`, `optchat:status:v1`, `optchat:status:ping:v1` | Preserve schemas and semantics; additive `integrations` capability section only. One capabilities emitter, no competing partial advertisements. |
| `optchat:main:status:v1`, `optchat:main:ping:v1` | Supported metadata: real lifecycle phase, generated activity/turn ID, sanitized tool name, pending boolean. **queueDepth:null / exactQueueDepth:false**. |
| `optchat:owner:event:v1` | Supported ready/replayed-ready/closing metadata with generation; best effort, no guaranteed death notice. |
| `optchat:conversation:request:v1`, `optchat:conversation:result:v1` | **submit/queue/steer unsupported**. Valid targeted requests get fixed `UNSUPPORTED_API` rejection, never dispatch input. Capabilities state the precise missing guarantees. |
| `optchat:output:subscribe:v1`, `optchat:output:unsubscribe:v1`, `optchat:output:event:v1` | Supported opt-in main-assistant text, bounded deltas/finals/terminal events and subscription acknowledgements. No conversation-input correlation claim. |
| `optchat:attention:event:v1` | Supported metadata-only observation of blocking UI prompt start/end. Locally generated ID; no title/options/answer content. |
| `optchat:attention:reply:v1`, `optchat:attention:result:v1` | **Generic replies unsupported**; fixed rejection, no UI/approval simulation. An observed request may end locally; cannot claim resolved by remote answer. |
| `optchat:agent:request:v1`, `optchat:agent:result:v1` | Opt-in, policy-checked top-level background spawn/steer/stop/resume via existing Children APIs. No connected-window takeover or arbitrary nested caller impersonation. |
| `optchat:history:request:v1`, `optchat:history:result:v1` | Opt-in bounded recent current-session branch text pages and selected non-connected run result. No full transcript, filesystem reads, old-profile memory-tree paging or arbitrary file paths. |

Capability-gated omission is an accepted outcome, not an excuse to advertise stubbed operations. Any feasible family requiring a missing seam must stop/report individually before continuing; never silently widen its contract.

## Architecture and planned files

Use a disposable owner integration coordinator, created only for a fully initialized active profile and never for plain Pi, remote or joined sessions. It composes the existing status publisher rather than replacing its projection/coalescer. Named modules are a suggested small-file boundary, not justification for adding frameworks:

- `src/events-contract.ts`: channel constants, DTOs, validation, finite limits, safe errors and pure text projection.
- `src/events-requests.ts`: owner/client/request scope, bounded idempotency and operation tracker.
- `src/owner-events.ts`: coordinator, main/attention metadata, lifecycle and additive capabilities.
- `src/output-events.ts`: opt-in streaming/subscriptions and reconciliation snapshots.
- `src/events-controls.ts`: Children adapter, read-only history/results adapter and unsupported request handlers.
- `src/index.ts`: narrow lifecycle/signal adapter, two boolean process flags; no replacement of existing journaling or input handling.
- `src/agent-status.ts`: optional typed capability contributor so its existing capabilities publisher remains authoritative; **no change to existing status DTO or observationOnly semantics**.
- New tests: `test/events-contract.test.ts`, `test/events-requests.test.ts`, `test/owner-events.test.ts`, `test/output-events.test.ts`, `test/events-controls.test.ts`, `test/events-integration.test.ts`.
- Documentation: update `docs/events-integration.md`, minimally cross-link `docs/agent-status.md` and README. No actual Discord bot/server/credentials.

Avoid dependency, core/durable, memory format, prompt, navigation, TUI renderer or settings-schema changes. New process flags are `--optchat-events-content` and `--optchat-events-control`, boolean/default false. They opt trusted in-process integrations into sensitive content and mutations independently. They are operator consent, not cryptographic authentication; a bridge must still authorize external identities and operations. Do not log task bodies or exception messages in new adapters. Do not refactor legacy Children diagnostics in this effort; report their existing warning behavior as a residual privacy limit, and keep new bus result/error payloads fixed.

## Common envelopes, authorization and bounds

All new request channels except metadata pings use `{version:1, clientId, requestId, ownerSessionId, operation?, payload?}`. Identifiers are 1–128 ASCII identifier characters; unknown additive fields are ignored but never echoed/fingerprinted as executable inputs. Validate unknown values before reading operation fields or allocating buffers. Unsupported versions/operations and invalid targeted requests get only fixed safe errors when a valid request ID can be recovered; malformed/unroutable traffic is ignored without payload logging.

Owner generation is a fresh opaque `ownerEpoch` on every coordinator lifetime, included in capabilities and every new envelope; requests must include it. `ownerSessionId` alone is insufficient if a profile reopens in the same session. Never retarget on switch. `clientId` and subscription IDs route messages on a shared bus, not ACLs. Discord IDs/tokens never enter core contracts. Content-bearing results contain only explicit text DTOs and correlation IDs, not tasks or payload echoes in general status.

Capabilities add `integrations:{version:1,ownerEpoch,metadata,content,control,unsupported,limits}` with literal event names, supported operations, enabled flags, and all limits. Keep existing `events`, `status` and `status.observationOnly:true` untouched. Disabled features advertise `enabled:false`; unsupported conversation/replies advertise `supported:false,reason:'PUBLIC_API_LIMIT'`. Existing status ping replays full additive capabilities. Main ping requires `{version:1,ownerSessionId,ownerEpoch}` and coalesces replay; it never mutates.

Settled finite limits (lower values are allowed only if docs/tests/capabilities change together):

| Resource | Bound |
| --- | --- |
| Parsed request | 64 KiB UTF-8 total executable string content; 32 KiB input text, 8 spawn tasks/batch |
| Work admission | 16 accepted in-flight requests; reject overflow immediately |
| Idempotency | ownerEpoch + clientId + requestId key; 10-minute retention, <=256 records, <=4 MiB retained results; never evict within the advertised retry window to admit new work |
| Operation deadline | 30 seconds; terminal `OUTCOME_UNKNOWN` on deadline for an already-dispatched mutation, not cancellation or permission to retry with a new ID |
| Metadata cadence | >=250ms anchored coalescing; attention/lifecycle/results are ordered facts, not snapshot-coalesced |
| Output subscriptions | <=8; 5-minute leases renewed by repeat subscribe; max 128 KiB retained assistant text/message; <=16 messages and <=512 KiB recovery cache |
| Output batches | <=8 KiB text/event, at most one delta batch/subscription/100ms; instantaneous queued-delta buffer <=32 KiB/subscription (no per-second throughput budget) |
| History page | <=20 items, <=64 KiB serialized result, <=16 KiB/item, <=200 recent candidate message entries; oversized text explicitly truncated |
| History cursors | <=16 server-held opaque snapshots, <=512 KiB total, 60-second expiry; owner/client scoped |
| Selected run result | <=32 KiB projected assistant text; no arbitrary report/error strings or raw transcript |

Never retain an unbounded raw request/object graph for dedupe. Parse into an allowlisted DTO, hash canonical validated semantics including operation/target/payload, and retain only fingerprint + bounded result. Same ID/same semantics replays current acknowledgement/terminal result without mutation; changed semantics, including changed operation, returns `REQUEST_CONFLICT`. Cache saturation rejects new work, including reads; in-flight work is not evicted. Expiry is lazy or one bounded timer, not one timer/request.

`accepted` means validation/policy passed and owner took responsibility for dispatch, **not** a child started or stopped. Terminal `completed` means the existing method returned; for stop it means abort was requested/awaited, not the run exited. Each result carries `requestId`, target ownerEpoch, operation, monotonic per-request sequence, phase and safe outcome. Unsupported/disabled requests are rejected before acceptance. Timed-out work keeps its mutation slot and generation guard until its actual promise settles; suppress late duplicate terminal results. Shutdown rejects not-yet-dispatched work, emits best-effort `OWNER_CLOSING` for accepted work, cancels timers, and prevents old completions publishing to a new owner. Crash/reload loses dedupe; clients must not blindly retry uncertain mutations in a new epoch.

## Main status and lifecycle semantics

- `turnId` is a generated ID for the current **agent activity through settlement**, not Pi's numerical provider/tool-loop `turnIndex`, nor a remote-input receipt. Ensure it once on before_agent_start/agent_start, clear only at agent_settled. A provider retry must not silently become a completed input.
- Phases: idle, working, responding (observed assistant text), awaiting-input (blocking UI prompt observed), closing. Do not infer thinking from time. Track phase precedence: closing > awaiting-input > active responding/working > idle. Ended tool/message resets must not declare idle before settlement.
- Expose `hasPendingMessages` from the public context and `queueDepth:null`. Sanitize tool names with the existing identifier rules; do not emit tool args/results or prompt titles. Multiple tools use a bounded set and a selected latest tool plus count; count overflow is marked unknown rather than fabricated.
- Observe `ui_prompt_start/end`; generated attention IDs describe observations only, expiry is null/unknown. Pair supported sequential/nested signals with a bounded stack, indicate ambiguity rather than matching by sensitive title. End means prompt no longer open, not approved/answered. There is no remote reply operation.
- Attach request listeners before first capability advertisement, then capabilities/background snapshot, then owner-ready/main snapshot. Same-session duplicate bind replays without duplicating listeners/epochs. Profile switch emits closing with old identity before disposal; replacement publishes a distinct epoch. Failed initialization emits no ready state. Process death may emit nothing.

## Sensitive output / history

Only `--optchat-events-content` allows subscriptions or history/results. Subscribe/unsubscribe use the shared envelope; acknowledgements are `output:event` kinds `subscribed`, `unsubscribed`, or `rejected`. A caller chooses subscriptionId (opaque identifier) and target epoch. Same subscription renews lease; explicit resync requests current bounded message snapshot rather than a lossless replay promise. Replies on the shared channel are addressed, not private.

Assistant message IDs are generated on public message_start and used consistently through updates/finals; do not derive them from content hashes, object identity across unrelated events or timestamps. Output event fields: owner/epoch/client/subscription, turnId, messageId, sequence, kind, bounded text, truncated/gap/replacement indicators. Forward **only text_delta** from assistantMessageEvent; never serialize its partial, thinking, toolcall, args, usage, provider errorMessage or raw message. Final text is allowlisted text blocks from assistant message_end, replacing the earlier accumulated text; emit even when no delta arrived. Message end is not turn completion; agent_settled produces completed/aborted/failed from observed stop state, with fixed error codes and no raw error strings. No content goes to non-subscribers.

If a subscriber buffer/cache cap is hit, discard/coalesce intermediate deltas, emit a gap marker and a bounded authoritative final/replacement snapshot. Final events may be multiple <=8 KiB chunks with snapshot ID/index/count; the receiver replaces once assembled, not appends duplicates. Recovery promises only retained bounded snapshots, never lossless output or full-text retrieval beyond the cap. Late subscribe replays current/retained state with explicit truncation/gap markers. Lease expiry/unsubscribe/disposal clears subscriber data. No unbounded event lists; Pi does not await slow consumers and this cannot provide network backpressure.

History `recent` projects current-session **branch message entries only**, user and assistant plain text; skip custom/system, hidden reports, tools, thinking, image data and structural file/session paths. Use a bounded tail, opaque snapshot cursors bound to epoch/client, explicit page byte caps and `nextCursor/truncated/omitted`. This is not profile-wide OptChat memory history; advertise scope `current-session-branch`. Do not modify or query memory internals.

Run-result reads validate an exact known profile-owned non-connected ID and `expectedStartedAt` generation. Project text blocks from the retained finalized assistant message, not `RunInfo.report`: reports may contain caught exception strings. Unfinished results return safe not-ready metadata; failed/aborted results give state + bounded assistant text if present, never errorMessage. Use existing `Children.retained` only; no arbitrary path reads/new transcript endpoints. A result may naturally contain user/assistant-authored paths or secrets; opt-in content is sensitive, not automatically redacted.

## Agent controls

Require `--optchat-events-control`, an available non-importing/non-stopping profile, target owner epoch, runtime validation and normal Children policies. Recheck owner generation and state after asynchronous boundaries. Never import/export raw LiveRun objects.

- `spawn`: explicit task/model/thinking (validate installed supported thinking enum); max8 tasks and limits above; use current owner cwd, **reject caller cwd/parent/caller impersonation**, use `children.spawn` with normal connected=false and no parent. Existing profile maxAgents/depth/model auth remain authoritative. Task-only UI label is not metadata. Return run IDs, not tasks. Starting agents still depends on explicit operator/bridge delegation authorization; a flag enables this trust delegation, not arbitrary Discord users.
- `steer`: exact known top-level, non-connected currently running run; require expectedStartedAt and state; `Children.tell` only after precheck so a finished run never implicitly resumes. Recheck immediately before call; if its implementation permits a race into implicit resume, add a narrow explicit mode/precondition to the OptChat public helper with tests, **not direct registry mutation**. Stop/report if this cannot preserve semantics in scope.
- `resume`: exact finished top-level non-connected run, expectedStartedAt; pass through `Children.tell` manager resume path. Paused/live runs are not advertised as this resume operation. Existing parent/model/auth/cwd/slot rules apply.
- `stop`: exact top-level non-connected live run with expectedStartedAt; use existing stop with normal cause. Descendants stop according to existing policy, not a new independent traversal.

No delete, arbitrary execution, permission approval, main abort, settings/profile switching or connected-window management endpoint. Bus adapter errors are fixed (`INVALID_REQUEST`, `STALE_OWNER`, `STALE_RUN`, `DISABLED`, `UNSUPPORTED_API`, `NOT_FOUND`, `INVALID_STATE`, `POLICY_DENIED`, `CAPACITY`, `REQUEST_CONFLICT`, `OUTCOME_UNKNOWN`, `OWNER_CLOSING`, `INTERNAL_ERROR`). Do not scrape exception strings to classify them: use prevalidated conditions, otherwise fixed INTERNAL_ERROR. Existing method state/status is the actual completion source, not acknowledgement wording.

## Implementation phases and gates

1. Reproduce baseline and pin seam tests; contracts, validator, request tracker.
2. Main metadata, owner lifecycle, capability composition, unsupported conversation/reply handlers.
3. Opt-in output plus real Pi lifecycle/privacy regressions.
4. Opt-in existing agent controls and bounded history/results, with race tests.
5. Discord-facing docs/example and full validation.
6. Independent Review -> optional Fix -> Final Review using operator routing. No completion claim before review. Maximum two fix/review cycles; persistent blockers return to operator.

## Risks, assumptions and explicit deferred work

- **Known blockers remain deferred:** strict submit/queue/steer input, exact queue depth, reply-capable generic attention, approvals. Revisit only with a public Pi API exposing delivery receipts/IDs and real reply handles. Do not upgrade Pi in this work.
- Main status/output are observational and may include unrelated local turns; a Discord bridge cannot promise remote conversation initiation or one-to-one input/output correlation. It can observe local activity, read opt-in content, and manage authorized children.
- Shared in-process listeners can read or mutate objects and Pi may log their exceptions; content opt-in is accidental-disclosure control, not extension sandboxing. Build fresh DTOs; freeze/copy cached results before emission to protect own state, without claiming protection from a malicious extension.
- Process flags are the settled default policy, avoiding profile config/memory changes. Bridge implementation/auth storage and actual Discord delivery remain external.
- No existing uncommitted work is reverted or committed. Runtime file modifications occur only in later implementation phase.

## Verification / acceptance

Use synthetic ModelRuntime fixtures and real public Pi event bus as in existing agent-status lifecycle tests; no credentials/network/Discord. Every accepted family has exact-key DTO tests, malformed/version/limit tests, sensitive sentinels, stale epoch/duplicate ID/conflicting payload tests, policy-off tests and owner cleanup tests. Validate payload byte limits with non-ASCII text and JSON escaping, stream gap/final reconciliation, timeout without redispatch, throwing getters/listeners and sync/async failures. Verify unchanged input journaling and local prompting by regression tests; unsupported input/reply requests cause zero calls/memory writes.

Capture baseline then final `npm run check`, `npm test`, `npm run build`, and `git diff --check`. Commands must run <=60s each (use 55s timeout and separate background polling for a longer suite); logs live outside the repo. Classify the previously reported model-registry failure only after baseline reproduction. No new failures allowed. Review changed-file boundaries, no package-lock/dependency changes, existing status regression suite, and docs/capability consistency. Final report names implemented/disabled/unsupported operations, tests/exits, residual limits, changed files and no-commit/no-push status.
