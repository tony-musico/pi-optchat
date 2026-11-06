# Plan: OptChat live agent status on Pi's event bus

## Goal and scope
Expose a bounded, privacy-safe snapshot from the profile-owner process so another extension can display agent status without importing OptChat or reading its files. This is observation only. This package is a plan, not an implemented or validated feature.

Non-goals: new tools/commands, agent control, cross-process transport, persistence, periodic polling, TUI/memory/Agents-page changes, dependencies, changes to RunHistory or LiveRun internals. Do not copy pi-subagents' control RPC.

## Repository findings
- `package.json` and lockfile pin the development Pi coding-agent package to `@earendil-works/pi-coding-agent` 1.4.0; peer range is >=1.2. Local node_modules is absent, so availability and semantics of its event bus remain a mandatory compatibility gate, not a verified fact.
- `src/index.ts`: `openProfile` establishes `active = { name, session, children, ... }`; same-owner repeated session_start is explicitly supported. `stop` and failed-open cleanup are the lifecycle disposal points. Joined/connected windows are separate paths and must not publish owner status.
- `Children.history.list()`, `Children.live(id)`, and `Children.subscribe()` already expose the required read surface. `observe()` updates `live.updated`, maintains `live.tools`, and notifies subscribers even during streaming. Do not add another child-session listener.
- `src/runs.ts`: reuse `isRunning`, `isHandingOff`, and RunInfo state/identity/timestamps/parentage. `src/inspector.ts` exports `elapsed(ms)`; reuse it rather than cloning the display-duration logic.
- Existing `test/session-switch.test.ts`, `test/headless.test.ts`, and related lifecycle tests provide integration patterns. Build currently includes only the core/durable entry points; do not expand package exports/build roots for this extension-only seam.
- Installed pi-subagents `docs/extension-api.md` advertises capabilities and event names on ping, prescribes subscribe-before-request, and states that pi.events is in-process only. Mirror these principles, not its task-bearing DTOs or management methods.

## Mandatory gate (before implementation)
Inspect the exact pinned package's public ExtensionAPI/event-bus types and implementation. Confirm emit/on, unsubscribe, dispatch/error behavior, and compatibility with the test loader. Dependency installation, if needed, must preserve the lockfile. Record exact evidence and any older-peer limitation.

Stop and report, without implementing a workaround, if the pinned version lacks pi.events, required state would need RunHistory/LiveRun internal changes, or the allowlisted payload cannot avoid task text. Never substitute file/socket transport, parsing transcripts, type casts to fake an API, or a widened peer range. If startup integration cannot be safely isolated, report that blocker too.

## Proposed v1 public contract
Names are literal strings; export constants internally for tests/docs, not a new package entry point:
- `optchat:status:v1`: complete replacement snapshot.
- `optchat:capabilities:v1`: owner-scoped capability advertisement, always delivered before its associated status snapshot.
- `optchat:status:ping:v1`: observation-only discovery/replay signal. Ignore its payload entirely; no request IDs, reply channels, targets, actions, or arguments. Multiple pings share the coalescer. This is not an agent-control request.

```ts
interface StatusV1 {
  version: 1;
  profile: string;                 // profile name, never directory
  ownerSessionId: string;          // session id, never session filename
  sampledAt: number;               // epoch milliseconds
  counts: {
    active: number;                // isRunning(run): running/waiting/stopping
    paused: number;                // state === 'paused'
    handingOff: number;            // isHandingOff(run)
    total: number;                 // all eligible runs, before cap
    omitted: number;               // total - agents.length
  };
  agents: Array<{
    runId: string;                 // existing opaque run id
    state: RunState;               // existing persisted state, not a new state machine
    handingOff: boolean;           // terminal state can still await handoff
    model: string | null;          // canonical bounded provider/model identifier
    elapsed: string;               // elapsed((ended ?? sampledAt) - started)
    currentTool: string | null;    // tool NAME only, never args/output
    lastActivityAt: number | null; // live.updated, else ended; unknown stays null
    parentId: string | null;
    depth: number;
  }>;
}
interface CapabilitiesV1 {
  version: 1;
  profile: string;
  ownerSessionId: string;
  events: {
    status: 'optchat:status:v1';
    capabilities: 'optchat:capabilities:v1';
    ping: 'optchat:status:ping:v1';
  };
  status: {
    version: 1;
    scope: 'profile-owner';
    inProcessOnly: true;
    observationOnly: true;
    maxAgents: 64;
    minIntervalMs: 250;
    fields: ['runId', 'state', 'handingOff', 'model', 'elapsed',
             'currentTool', 'lastActivityAt', 'parentId', 'depth'];
    titles: false;
  };
}
```

### Semantics and bounds
- Eligible set: profile history records satisfying isRunning, paused, or isHandingOff. Include descendants and connected children owned by this profile. Exclude delivered terminal history and the main owner agent. No extra current-session filter: this reports the owner's complete profile fleet, including recovered work.
- Counts use the full eligible set; categories are mutually exclusive with current helpers, so total = active + paused + handingOff. Omitted counts eligible rows excluded by the 64-row cap, not old historical runs.
- Preserve `history.list()` ordering, filter, then slice to 64; do not invent a second ordering/state policy. A parent can be absent due to filtering/capping; hosts must tolerate that. Test deterministic source ordering including nesting.
- For simultaneous tools, choose the most recently started tool; break ties deterministically using the existing tool map key, without exposing that key. Return only the name. Missing live data gives null tool; lastActivityAt is a timestamp, never prose. Never synthesize activity from task/report text.
- Use a fresh explicit object allowlist at every level: never spread RunInfo/LiveRun, serialize maps/sessions, or reuse mutable source objects in events. Titles are omitted in v1 because there is no safety/provenance marker on RunInfo.title. Never fall back to agentLabel (it may use task text).
- Bound all strings as well as row count: profile <=128, owner/run/parent IDs <=128, model <=256, tool name <=128, elapsed <=64 characters. Validate canonical identity syntax and finite numeric values; optional model/tool identifiers that fail validation become null, not raw text. Do not truncate identities. Verify existing profile/session/run validation before settling compatible identity checks; if required identity cannot be represented safely, stop/report rather than silently drop rows or leak raw values. Tools permit identifier syntax only, not arbitrary display strings. No task, title, transcript, guidance, report/handoff text, cwd, sessionFile, tool arguments/output, or file paths under any key.
- Consumer treats snapshot as replacement, ignores unknown fields, checks version and capabilities, and treats null as unknown. Existing fields never change meaning/type within v1; additive optional fields are ignorable. Breaking changes require a new event namespace and version. No authentication boundary exists between trusted same-process extensions.

## Emitter and lifecycle
Add `src/agent-status.ts` for contract constants/types, pure projection, and a disposable publisher with injectable clock/scheduler/bus for tests. Runtime imports from existing helpers are allowed; do not modify inspector/TUI code to reuse elapsed. Keep module loading compatible with existing extension/test environment.

Attach one publisher after successful owner initialization, before recovery starts. Subscribe before the initial projection; emit capabilities then a status snapshot (including an empty fleet). Avoid duplicate subscription on same-owner RPC rebind; allow a bounded replay there, not another publisher. No publication in joined/remote/child processes merely because the extension loaded.

For child notifications and ping, mark dirty and schedule at most one flush no sooner than 250ms after the preceding publication. Anchor a pending deadline; later activity cannot indefinitely postpone it. Project the latest state at flush time, not every streaming callback. A ping forces a bounded capabilities-then-status replay even if the fleet is unchanged; normal updates suppress identical observable snapshots (ignore sampledAt/elapsed-only drift for equality). Reentrant notifications must retain a subsequent dirty flush; never recurse into publication. No periodic timer/heartbeat. Durations are sampled, not continuously refreshed.

Make disposal idempotent: deactivate first, unsubscribe Children and ping, cancel timer, discard pending dirty work. Call it at the start of stop/profile teardown, before asynchronous child closing, and in failed-open cleanup. A stale scheduled callback must check disposal/owner generation before emitting. One publisher cannot emit another profile's data. No false all-zero shutdown snapshot or new terminal event is required; consumers discard caches on their own session/owner lifecycle. Document that abrupt process exit cannot send an invalidation.

Publisher/listener failures must not alter agent execution or throw from Children.subscribe. Verify actual bus semantics at the gate and isolate publication exceptions using existing warning conventions without logging payloads. Bound warning repetition. A consumer mutating event objects must never mutate RunInfo/LiveRun (fresh projection).

## Workstreams / acceptance
1. Compatibility gate and settled source mapping; no forbidden internal edits.
2. Pure bounded projection plus projection unit tests.
3. Coalesced disposable publisher plus deterministic emitter tests.
4. Owner lifecycle wiring plus startup/rebind/shutdown/switch/failure/headless coverage.
5. `docs/agent-status.md`, README link, and final full validation.

Acceptance: all required fields/counts and privacy properties are tested; advertise-before-use and late-subscriber ping work; a busy fleet produces at most one scheduled update/replay per 250ms; teardown emits nothing stale; current tools/commands/TUI/memory/Agents behavior and dependencies remain unchanged. `npm run check`, `npm test`, `npm run build` all pass.

## Risks / deliberately excluded
The pinned SDK event bus is not yet verified locally. History can be large even though payload is capped; use one coalesced pass, not per-token projection. Brief states can disappear between coalesced snapshots: this is status, not an audit log. Counts are authoritative beyond the row cap. Current helper semantics mean waiting/stopping count active. Unsupported title safety is handled by omission, not sanitization guesses. No terminal history feed, raw token/output stream, tasks/titles, control RPC, transport, new dependency, or changes to core/durable build exports.

## Delivery evidence
Final implementation report must list changed files, exact final event names/fields and bounds, targeted and full test command outputs/exit codes, privacy/lifecycle checks, and deliberate exclusions. Record baseline failures separately; never call unrun or failed checks successful. This planning pass does not claim test results.

## Implementation notes (gate evidence and settled decisions)

### Gate: the pinned event bus
- `@earendil-works/pi-coding-agent` 1.4.0 is installed and pinned; `package.json` and `package-lock.json` are unchanged.
- `dist/core/event-bus.d.ts` declares `EventBus { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void; }`, and `ExtensionAPI.events: EventBus` (`dist/core/extensions/types.d.ts`). The bus exists, so the seam is public.
- `dist/core/event-bus.js`: `on` wraps the handler in an async safe handler that catches and logs what a handler throws, so a handler cannot break the emitter; `emit` is Node's EventEmitter and dispatches synchronously, and a handler body runs synchronously up to its first `await`.
- `dist/core/extensions/loader.js`: the API's `events.emit` runs `assertActive()` first, so it throws once the extension is stale or failed, and `events.on` returns a tracked unsubscribe that the runtime revokes on invalidation. The bus is created per resource loader (`DefaultResourceLoader`'s `eventBus` option) and shared by every extension it loads, which is what makes the seam in-process.
- Identity sources, verified: profile names match `/^[a-z0-9][a-z0-9_-]{0,63}$/` (`src/profiles.ts`); session ids are uuidv7 and match Pi's own `/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`; run ids are `randomUUID().slice(0, 8)` or an id read back from disk and validated by `/^[a-zA-Z0-9-]+$/` (`src/runs.ts`); models are `provider/id` (`src/agents.ts`). None of them can hold prose, so the bounds in this plan are compatible with real values.

### Settled decisions
1. **A ping shares the coalescer.** A ping forces a capabilities-then-status replay, but inside the same 250 ms window as everything else, so a burst of pings cannot become a flood. The host is answered within 250 ms.
2. **An identity that cannot be published safely stops the snapshot.** A run id outside the rules ends the projection instead of shortening the id or dropping the row, so the counts never disagree with the list. The owner warns once and publishes nothing until it can.
3. **`pi.events` is feature-detected.** The peer range still allows Pi 1.2, which may have no event bus, so the publisher checks for `emit`/`on` at runtime and publishes nothing when they are missing rather than failing to start.
4. **Capabilities precede every status**, not only the first one, so "advertise before use" holds on every path.
5. **The publisher is per owner.** The owner generation is the publisher object: a new owner gets a new publisher, and the old one is disposed before the profile is torn down, so a stale callback cannot publish another profile's fleet.
6. **A failure is reported by what failed, never by what it said.** Every caught error in `src/agent-status.ts` produces one of a fixed set of diagnostic lines ("the event bus refused the message", "the agents could not be read", "the status could not be built", "the status could not be scheduled", "the profile or session identity is not publishable", "an agent identity is not publishable", "OptChat could not watch its agents.", "OptChat could not answer a status ping."). No caught error object is read, so no task text, path or bus payload can reach a warning, the screen or the log.
