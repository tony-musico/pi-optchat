# Pi events integration guide

OptChat exposes a capability-gated, in-process event contract for trusted Pi extensions. This guide describes the **implemented I1–I8 contract**, not a future proposal.

The original background-agent status API remains available and observation-only. See [Live agent status](agent-status.md) for that separate three-channel contract. The main-agent, output, control, and history families described here are additive integrations with their own consent flags.

There is **no shipped Discord transport**. A Discord bot would be an external bridge over `pi.events`; that bridge would own authentication, authorization, rate limiting, durable delivery, and Discord-specific identifiers.

## Trust boundary and scope

- `pi.events` is local to one Pi process. A separately running bot cannot subscribe to another process's bus.
- Extensions in the same process are already trusted. Channel names, client IDs, request IDs, owner IDs, and epochs are routing data, not authentication or sandboxing.
- The two integration flags are independent operator consent, not proof that an external identity is authorized.
- Do not assume that remote, joined, print, or JSON sessions provide this contract. A consumer must bind the actual owner identity it observes and discard state when that owner closes or changes.
- The content flag does not redact user- or assistant-authored text. Text may naturally contain secrets or paths.
- No remote conversation submission, exact queue-depth reporting, generic attention reply, approval simulation, durable delivery, Discord credentials, or Discord dependencies are included.

## Independent consent flags

Both flags are registered as boolean Pi CLI flags and default to `false`:

| CLI flag | Default | Enables |
| --- | --- | --- |
| `--optchat-events-content` | `false` | Assistant-output subscriptions and bounded history/result reads. |
| `--optchat-events-control` | `false` | Spawn, steer, stop, and resume operations for authorized background agents. |

There are no other event-integration flags and no settings-schema entry for these flags. Enabling one does not enable the other.

## Exact channels

Every channel name below is literal. Every versioned payload in this contract has `"version": 1`.

| Channel | Direction | Implemented behavior |
| --- | --- | --- |
| `optchat:capabilities:v1` | owner → consumer | `StatusCapabilitiesV1`, including the additive `integrations` capability when the owner coordinator is present. |
| `optchat:status:v1` | owner → consumer | The bounded background-agent `StatusV1` snapshot. |
| `optchat:status:ping:v1` | consumer → owner | Payload-free legacy status replay request; its payload is ignored. |
| `optchat:main:status:v1` | owner → consumer | The bounded main-activity `MainStatusV1` snapshot. |
| `optchat:main:ping:v1` | consumer → owner | Payload-free main-status replay request; its payload is ignored. |
| `optchat:owner:event:v1` | owner → consumer | Owner `ready`, `replayed-ready`, or `closing` lifecycle fact. |
| `optchat:conversation:request:v1` | consumer → owner | Conversation submit/queue/steer request. It is parsed and then rejected without dispatch. |
| `optchat:conversation:result:v1` | owner → consumer | Fixed `EventRequestResultV1` rejection for a conversation request. |
| `optchat:output:subscribe:v1` | consumer → owner | `output:subscribe` or `output:resync` request. There is no separate resync channel. |
| `optchat:output:unsubscribe:v1` | consumer → owner | `output:unsubscribe` request. |
| `optchat:output:event:v1` | owner → consumer | Output acknowledgement, delta, final, gap, and settlement event. |
| `optchat:attention:event:v1` | owner → consumer | Metadata-only attention `started` or `ended` observation. |
| `optchat:attention:reply:v1` | consumer → owner | Attention-reply request. It is parsed and then rejected without dispatch. |
| `optchat:attention:result:v1` | owner → consumer | Fixed `EventRequestResultV1` rejection for an attention reply. |
| `optchat:agent:request:v1` | consumer → owner | Spawn, steer, stop, or resume request. |
| `optchat:agent:result:v1` | owner → consumer | Accepted and terminal `EventRequestResultV1` for an agent request. |
| `optchat:history:request:v1` | consumer → owner | Recent-history or selected-result request. |
| `optchat:history:result:v1` | owner → consumer | Accepted and terminal `EventRequestResultV1` for a history request. |

The background-agent status capability and snapshot still have their own version tags. Their `status.observationOnly: true` statement applies to that background-agent snapshot contract; it does not describe the separately gated integrations below.

## Owner identity and discovery

The owner creates a fresh opaque `ownerEpoch` for each coordinator lifetime. The epoch appears in the integrations capability, owner/main/attention/output/request/result payloads, and is required on every request.

A numeric owner `generation` also appears in owner lifecycle events and increases when OptChat creates a replacement owner. It is not a substitute for the opaque epoch.

The additive capability has this shape:

```json
{
  "version": 1,
  "ownerEpoch": "b35f5d84-1f75-4fa9-8af8-b0d89a438f53",
  "metadata": { "enabled": true },
  "content": { "enabled": false },
  "control": { "enabled": false },
  "unsupported": [
    { "operation": "conversation:submit", "reason": "PUBLIC_API_LIMIT" },
    { "operation": "conversation:queue", "reason": "PUBLIC_API_LIMIT" },
    { "operation": "conversation:steer", "reason": "PUBLIC_API_LIMIT" },
    { "operation": "attention:reply", "reason": "PUBLIC_API_LIMIT" }
  ],
  "limits": { "...": "the exact table below" }
}
```

The epoch is included in the legacy status capability's additive `integrations` object. A same-session rebind replays the same epoch; a replacement owner receives a distinct epoch. Consumers must never retarget a request after an owner change.

Owner lifecycle events are exact-key `OwnerEventV1` objects:

```json
{
  "version": 1,
  "ownerSessionId": "session-owner-id",
  "ownerEpoch": "b35f5d84-1f75-4fa9-8af8-b0d89a438f53",
  "generation": 3,
  "kind": "ready"
}
```

`kind` is `ready`, `replayed-ready`, or `closing`. Closing is best effort: process death cannot publish it.

## Common request and result envelopes

Except for the two payload-free ping channels, request families use this envelope:

```json
{
  "version": 1,
  "clientId": "discord-bridge",
  "requestId": "opaque-request-id",
  "ownerSessionId": "session-owner-id",
  "ownerEpoch": "b35f5d84-1f75-4fa9-8af8-b0d89a438f53",
  "operation": "history:recent",
  "payload": {
    "limit": 20,
    "cursor": null
  }
}
```

`clientId`, `requestId`, `ownerSessionId`, and `ownerEpoch` are opaque identifiers of at most 128 characters. Unknown additive fields are ignored and never enter executable semantics. Caller/parent/cwd impersonation fields are rejected before dispatch.

The generic result envelope is:

```json
{
  "version": 1,
  "clientId": "discord-bridge",
  "requestId": "opaque-request-id",
  "ownerSessionId": "session-owner-id",
  "ownerEpoch": "b35f5d84-1f75-4fa9-8af8-b0d89a438f53",
  "operation": "history:recent",
  "phase": "completed",
  "sequence": 2,
  "outcome": {
    "status": "ok",
    "code": null,
    "value": {}
  }
}
```

| Phase | Sequence | Meaning |
| --- | --- | --- |
| `rejected` | 0 | Validation, policy, owner, state, or capacity failed before acceptance. No operation was dispatched. |
| `accepted` | 1 | Validation and policy passed and the owner accepted responsibility for dispatch. Acceptance does not mean a child started or stopped. |
| `completed` | 2 | The dispatched method returned, or a fixed terminal failure was published. For stop, this means stop was requested/awaited, not that the run exited. |

Output subscribe/unsubscribe/resync acknowledgements are deliberately **not** generic request results. They use `OutputEventV1` on `optchat:output:event:v1` with kind `subscribed`, `unsubscribed`, or `rejected`.

### Operation payloads

| Operation | Request channel | Exact payload |
| --- | --- | --- |
| `output:subscribe` | `optchat:output:subscribe:v1` | `{ "subscriptionId": "subscription-id" }` |
| `output:unsubscribe` | `optchat:output:unsubscribe:v1` | `{ "subscriptionId": "subscription-id" }` |
| `output:resync` | `optchat:output:subscribe:v1` | `{ "subscriptionId": "subscription-id" }` |
| `agent:spawn` | `optchat:agent:request:v1` | `{ "tasks": [{ "task": "...", "model": "provider/model", "thinking": "off" }] }` |
| `agent:steer` | `optchat:agent:request:v1` | `{ "runId": "run-id", "expectedStartedAt": 123, "message": "..." }` |
| `agent:resume` | `optchat:agent:request:v1` | `{ "runId": "run-id", "expectedStartedAt": 123, "message": "..." }` |
| `agent:stop` | `optchat:agent:request:v1` | `{ "runId": "run-id", "expectedStartedAt": 123 }` |
| `history:recent` | `optchat:history:request:v1` | `{ "limit": 20, "cursor": null }` |
| `history:result` | `optchat:history:request:v1` | `{ "runId": "run-id", "expectedStartedAt": 123 }` |
| `conversation:submit` | `optchat:conversation:request:v1` | `{ "text": "..." }`; rejected and never dispatched. |
| `conversation:queue` | `optchat:conversation:request:v1` | `{ "text": "..." }`; rejected and never dispatched. |
| `conversation:steer` | `optchat:conversation:request:v1` | `{ "text": "..." }`; rejected and never dispatched. |
| `attention:reply` | `optchat:attention:reply:v1` | `{ "attentionId": "attention-id", "answer": null }`; rejected and never dispatched. |

For `agent:spawn`, validation requires an explicit authenticated model and supported thinking level even though the parser permits nullable fields. Task text and steer/resume messages are bounded to 32 KiB. A spawn contains at most eight tasks.

### Idempotency, deadlines, and capacity

- The idempotency key is `ownerEpoch + clientId + requestId`.
- The semantic fingerprint includes the validated operation and payload. Reusing an ID with different semantics returns `REQUEST_CONFLICT`.
- For generic request families, a same-ID, same-semantics request replays the retained acknowledgement or terminal result without dispatching again. Output acknowledgements use their own family-specific path.
- Generic request results are retained for 10 minutes. The tracker accepts at most 256 retained records and 4 MiB of retained results. Saturation rejects new work with `CAPACITY`; live records are not evicted to make room.
- At most 16 requests may be in flight. Admission overflow is rejected immediately.
- Every accepted request has a 30-second operation deadline. A deadline publishes terminal `OUTCOME_UNKNOWN`; it does not prove that a mutation did or did not happen.
- A timed-out dispatched mutation keeps its in-flight slot and generation guard until the underlying method actually settles. Its late completion cannot publish a second terminal result. Retrying the same mutation under a new request ID is not permission to bypass the uncertainty.
- Owner disposal signals accepted adapter work to abort and publishes fixed `OWNER_CLOSING` terminal results where possible.

## Fixed errors

Errors contain only a fixed code and fixed public message. They never echo request bodies, task text, prompts, caught exception text, provider errors, or paths.

| Code | Meaning |
| --- | --- |
| `INVALID_REQUEST` | The request or payload is malformed or out of range. |
| `STALE_OWNER` | The owner session or epoch is not current. |
| `STALE_RUN` | The target run generation no longer matches `expectedStartedAt`. |
| `DISABLED` | The required content or control consent is off. |
| `UNSUPPORTED_API` | The version or operation is unsupported by the public Pi API. |
| `NOT_FOUND` | The target, cursor, or result does not exist. |
| `INVALID_STATE` | The target is not in a valid state for the operation. |
| `POLICY_DENIED` | Owner, client, delegation, or impersonation policy denied the request. |
| `CAPACITY` | A documented request-admission, retained-result, or subscription limit was reached. |
| `REQUEST_CONFLICT` | The ID/subscription conflicts with an earlier request or another client. |
| `OUTCOME_UNKNOWN` | The operation deadline elapsed before its outcome was known. |
| `OWNER_CLOSING` | The owner is closing or disposed. |
| `INTERNAL_ERROR` | The integration failed internally without exposing exception text. |

## Main-agent status and attention

`MainStatusV1` is a replaceable snapshot, not a lossless event log:

```json
{
  "version": 1,
  "ownerSessionId": "session-owner-id",
  "ownerEpoch": "b35f5d84-1f75-4fa9-8af8-b0d89a438f53",
  "phase": "working",
  "turnId": "generated-activity-id",
  "currentTool": "bash",
  "toolCount": 1,
  "pending": false,
  "queueDepth": null,
  "exactQueueDepth": false,
  "sampledAt": 1760000000000
}
```

- `phase` is `idle`, `working`, `responding`, `awaiting-input`, or `closing`. Phase precedence is closing, awaiting input, active responding/working, then idle.
- `turnId` is generated for one main activity through settlement. It is not Pi's provider-loop turn number and is not a remote-input receipt.
- `currentTool` is a sanitized name, never arguments or output. `toolCount` becomes `null` if the bounded observed set overflows.
- `pending` comes from Pi's public pending-message state. `queueDepth` is always `null` and `exactQueueDepth` is always `false`; OptChat does not guess an exact queue depth.
- Main-status changes are coalesced with a 250 ms anchored interval. Owner readiness publishes an initial snapshot; a main ping requests another one.

Attention events are metadata only:

```json
{
  "version": 1,
  "ownerSessionId": "session-owner-id",
  "ownerEpoch": "b35f5d84-1f75-4fa9-8af8-b0d89a438f53",
  "attentionId": "generated-attention-id",
  "kind": "started",
  "ambiguous": false
}
```

The coordinator pairs supported sequential/nested UI-prompt observations with a bounded stack and marks overflow or ambiguous pairing with `ambiguous: true`. It never publishes prompt titles, options, answers, permission decisions, or a UI reply handle. An attention end means the observed prompt closed, not that it was approved or answered. The `attention:reply` operation is rejected with `UNSUPPORTED_API`.

Conversation submit, queue, and steer requests are also rejected with `UNSUPPORTED_API`. They do not enter Pi's input journal, memory, permission handling, or approval flow.

## Opt-in assistant output

Output requires `--optchat-events-content`. A subscription is identified by the caller-selected `subscriptionId` and scoped to its `clientId`.

- At most eight subscriptions exist at once. Each lease lasts five minutes; repeating `output:subscribe` with the same ID and client renews it.
- Another client using the same subscription ID receives `REQUEST_CONFLICT`.
- The owner returns `subscribed`, `unsubscribed`, or `rejected` acknowledgements on `optchat:output:event:v1`.
- `output:resync` replays the current bounded retained final snapshot and any gap marker. It does not promise lossless delta replay.
- Only assistant text deltas and allowlisted final text blocks are published. Reasoning/thinking, tool calls and arguments, tool results, images, usage, partial/raw messages, prompt text, and provider error text are excluded.
- Text deltas are flushed at most once per subscription per 100 ms. The queued delta bytes buffered per subscription are limited to 32768 (32 KiB). This is an instantaneous buffer ceiling, not a per-second throughput or token allowance: no per-second rate budget is advertised or enforced, and throughput is bounded by producer input. If the per-subscription buffer ceiling is exceeded, intermediate deltas are discarded/coalesced and a `gap` marker is emitted.
- A final is authoritative replacement text, not an append. Large finals may be split into events of at most 8 KiB with `snapshotId`, `snapshotIndex`, and `snapshotCount`; the receiver replaces its accumulated text after assembling the snapshot.
- Recovery retains at most 16 messages, at most 128 KiB of text per message, and at most 512 KiB total. Eviction or truncation is represented by a gap rather than silently pretending the recovery cache is complete.
- `completed`, `failed`, and `aborted` are settlement-only terminal facts. A failed output event uses the fixed `INTERNAL_ERROR` code and never includes the provider's error text.

`OutputEventV1` carries the owner identity, addressed `clientId`/`subscriptionId`, optional request/turn/message IDs, a per-subscription sequence, kind, bounded text, and explicit `truncated`, `gap`, `replacement`, and snapshot fields.

Pi's event bus does not provide network backpressure or await a slow consumer. A bridge must apply its own rate limits and durable-delivery policy.

## Authorized agent controls

Agent operations require `--optchat-events-control` and use the generic request/result envelope.

- `agent:spawn` requires one to eight tasks, each with explicit task, authenticated model, and supported thinking level. It returns run IDs, not task bodies. It uses the current owner's working directory and normal Children model, depth, and maximum-agent policy.
- `agent:steer` targets an exact live, top-level, non-connected running run and requires `runId` plus matching `expectedStartedAt`. It cannot become an implicit resume.
- `agent:resume` targets an exact finished, top-level, non-connected run and uses the existing manager-resume path.
- `agent:stop` targets an exact live, top-level, non-connected active run. Its successful value is `accepted: "stop-requested"`; it does not claim that the run has exited.
- Nested, connected, unknown, stale-generation, wrong-state, unavailable-model, and over-capacity targets are rejected before mutation.
- Callers cannot choose a cwd, parent, or caller identity. No delete, arbitrary execution, permission approval, connected-window management, or profile switching operation exists.

## Bounded current-session history

History requires `--optchat-events-content` and uses the generic request/result envelope.

### Recent branch pages

`history:recent` returns `HistoryPageV1`:

```json
{
  "version": 1,
  "ownerSessionId": "session-owner-id",
  "ownerEpoch": "b35f5d84-1f75-4fa9-8af8-b0d89a438f53",
  "scope": "current-session-branch",
  "items": [
    { "id": "entry-id", "role": "user", "text": "bounded text", "truncated": false }
  ],
  "nextCursor": "opaque-cursor-or-null",
  "truncated": false,
  "omitted": 0
}
```

- Scope is the current owner's current session branch only. This is **not** profile-wide OptChat memory history.
- At most 200 message entries are considered.
- Only user and assistant plain text blocks are projected. Custom messages, system/compaction structure, tool-result messages, thinking, tool calls, images, and other roles/blocks are skipped.
- A page contains at most 20 items, each serialized history item is at most 16 KiB, and the serialized terminal result is at most 64 KiB.
- `omitted` is the snapshot-level count of entries permanently unavailable because projection skipped them or a cache bound dropped them. Items merely deferred to `nextCursor` are not omitted and are not counted again on later pages.
- `truncated` is true when text or entries were actually lost (including a permanently truncated item or omitted entry); it is false when the only effect is that more items are available through `nextCursor`. `nextCursor` is null at the end of the available page sequence.

Cursors are random opaque server-held snapshots, scoped to owner session, owner epoch, and client:

- At most 16 snapshots and 512 KiB total are retained.
- A cursor expires after 60 seconds.
- The oldest snapshot is evicted first when the count or byte bound is reached.
- A forged, expired, or evicted cursor returns `NOT_FOUND`.
- A cursor used by a foreign owner or epoch returns `STALE_OWNER`.
- A cursor used by a foreign client returns `POLICY_DENIED`.

### Selected finalized run results

`history:result` requires an exact `runId` and matching `expectedStartedAt` for a current, top-level, non-connected run.

- An unfinished run returns safe metadata with `ready: false`, its current state, empty text, and no retained-message read.
- A finalized run projects text blocks only from the last retained assistant message, capped at 32 KiB.
- `RunInfo.report`, raw provider/application error strings, thinking, tool output, and retained source metadata are never published.
- The result shape is exact-key: `version`, `runId`, `state`, `ready`, `text`, and `truncated`.

### Public source-read caveat

The implementation uses only public `sessionManager.getBranch()` and `Children.retained()` APIs. Pi may copy or read those existing sources in full. The 200-entry, 20-item, 16 KiB, 64 KiB, 512 KiB, and 32 KiB limits bound the new projections, cursor snapshots, and results; they do **not** bound Pi's underlying source I/O.

If a hard source-read limit is required, archived run results should be deferred rather than served by hand-rolling filesystem streaming or private SDK access.

## Advertised limits

The `integrations.limits` capability publishes these exact values.

<!-- EVENT_LIMITS_TABLE_START -->
| Key | Exact value | Meaning |
| --- | --- | --- |
| `executableStringBytes` | `65536` | Maximum parsed executable string content, including JSON escaping. |
| `inputTextBytes` | `32768` | Maximum task/steer/resume input text. |
| `spawnTasks` | `8` | Maximum tasks in one spawn request. |
| `inFlightRequests` | `16` | Maximum accepted in-flight requests. |
| `idempotencyRecords` | `256` | Maximum retained request records. |
| `retainedResultBytes` | `4194304` | Maximum retained request-result bytes. |
| `retryWindowMs` | `600000` | Request idempotency retention window. |
| `operationDeadlineMs` | `30000` | Accepted-operation deadline. |
| `metadataCoalesceMs` | `250` | Main-status coalescing interval. |
| `outputSubscriptions` | `8` | Maximum simultaneous output subscriptions. |
| `retainedMessageBytes` | `131072` | Maximum retained assistant text per recovery message. |
| `retainedMessages` | `16` | Maximum messages in the output recovery cache. |
| `recoveryCacheBytes` | `524288` | Maximum total output recovery-cache text. |
| `outputEventBytes` | `8192` | Maximum text in one output event. |
| `outputBatchIntervalMs` | `100` | Output delta batching interval. |
| `queuedDeltaBytes` | `32768` | Instantaneous queued-delta buffer ceiling per subscription; not a per-second throughput budget. |
| `historyItems` | `20` | Maximum items in one history page. |
| `historyPageBytes` | `65536` | Maximum serialized history terminal result. |
| `historyItemBytes` | `16384` | Maximum serialized history item. |
| `historyCandidates` | `200` | Maximum message entries considered for recent history. |
| `historyCursors` | `16` | Maximum cached history cursors. |
| `historyCursorBytes` | `524288` | Maximum total cached history-cursor bytes. |
| `historyCursorTtlMs` | `60000` | History-cursor lifetime. |
| `runResultTextBytes` | `32768` | Maximum projected selected-result assistant text. |
<!-- EVENT_LIMITS_TABLE_END -->

## Discord bridge boundary

A Discord bridge is an **authorized external client of this in-process bus**, not a feature shipped by OptChat. It must:

1. Bind an explicit owner session and epoch, and invalidate that binding on owner close/replacement.
2. Attach its bus listeners before pinging so a late host can discover the owner.
3. Subscribe before requesting main status when output is wanted, renew the five-minute output lease, and unsubscribe/dispose on shutdown.
4. Authorize every external guild, channel, user, operation, and target before emitting a request. The flags are operator consent, not an external ACL.
5. Filter every result/event by the expected owner, client, request, and subscription identity.
6. Deduplicate retries, honor Discord rate limits, reconcile replacement finals after gaps, and implement its own durable-delivery policy if required.
7. Keep Discord IDs, credentials, formatting, and transport outside OptChat's event payloads and logs.

This illustrative in-process pattern binds the owner from capabilities, subscribes before pinging main status, filters addressed results, and leaves external authorization to the bridge. It is documentation, not a shipped transport:

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const CAPABILITIES = 'optchat:capabilities:v1';
const STATUS_PING = 'optchat:status:ping:v1';
const MAIN_PING = 'optchat:main:ping:v1';
const OWNER = 'optchat:owner:event:v1';
const OUTPUT_SUBSCRIBE = 'optchat:output:subscribe:v1';
const OUTPUT_UNSUBSCRIBE = 'optchat:output:unsubscribe:v1';
const OUTPUT_EVENT = 'optchat:output:event:v1';
const AGENT_REQUEST = 'optchat:agent:request:v1';
const AGENT_RESULT = 'optchat:agent:result:v1';

const CLIENT_ID = 'discord-bridge-example';
const SUBSCRIPTION_ID = 'discord-output';

type Owner = { ownerSessionId: string; ownerEpoch: string };
type AgentCommand = { requestId: string; runId: string; expectedStartedAt: number };

export default function eventsBridge(pi: ExtensionAPI) {
  let owner: Owner | undefined;
  const pendingAgentRequests = new Set<string>();

  // The bridge's own ACL would make this decision. The sample authorizes nothing.
  const authorizeExternalCommand = (_command: unknown): boolean => false;
  const sendAuthorizedAgentRequest = (command: AgentCommand) => {
    if (!owner || !authorizeExternalCommand(command)) return;
    pendingAgentRequests.add(command.requestId);
    pi.events.emit(AGENT_REQUEST, {
      version: 1,
      clientId: CLIENT_ID,
      requestId: command.requestId,
      ownerSessionId: owner.ownerSessionId,
      ownerEpoch: owner.ownerEpoch,
      operation: 'agent:stop',
      payload: { runId: command.runId, expectedStartedAt: command.expectedStartedAt },
    });
  };

  const outputRequest = (operation: 'output:subscribe' | 'output:unsubscribe') => {
    if (!owner) return;
    pi.events.emit(operation === 'output:subscribe' ? OUTPUT_SUBSCRIBE : OUTPUT_UNSUBSCRIBE, {
      version: 1,
      clientId: CLIENT_ID,
      requestId: operation === 'output:subscribe' ? 'subscribe-discord-output' : 'unsubscribe-discord-output',
      ownerSessionId: owner.ownerSessionId,
      ownerEpoch: owner.ownerEpoch,
      operation,
      payload: { subscriptionId: SUBSCRIPTION_ID },
    });
  };

  const off = [
    pi.events.on(CAPABILITIES, data => {
      const capability = data as {
        version: number;
        ownerSessionId: string;
        integrations?: { version: number; ownerEpoch: string };
      };
      const epoch = capability.integrations;
      if (capability.version !== 1 || epoch?.version !== 1) return;
      owner = { ownerSessionId: capability.ownerSessionId, ownerEpoch: epoch.ownerEpoch };

      outputRequest('output:subscribe');
      pi.events.emit(MAIN_PING, {}); // output subscription was requested first
    }),
    pi.events.on(OWNER, data => {
      const event = data as { version: number; kind: string };
      if (event.version === 1 && event.kind === 'closing') {
        outputRequest('output:unsubscribe');
        owner = undefined;
      }
    }),
    pi.events.on(OUTPUT_EVENT, data => {
      const event = data as { version: number; clientId: string | null; subscriptionId: string };
      if (event.version !== 1 || event.clientId !== CLIENT_ID || event.subscriptionId !== SUBSCRIPTION_ID) return;
      // Route only addressed output to the bridge's own delivery layer.
    }),
    pi.events.on(AGENT_RESULT, data => {
      const result = data as {
        version: number; clientId: string; requestId: string;
        ownerSessionId: string; ownerEpoch: string; phase: 'rejected' | 'accepted' | 'completed';
      };
      if (result.version !== 1 || result.clientId !== CLIENT_ID || !pendingAgentRequests.has(result.requestId)
        || !owner || result.ownerSessionId !== owner.ownerSessionId || result.ownerEpoch !== owner.ownerEpoch) return;
      if (result.phase === 'accepted') return; // acceptance is not completion; keep the ID pending
      if (result.phase !== 'completed' && result.phase !== 'rejected') return;
      pendingAgentRequests.delete(result.requestId);
      // Only the terminal result completes this bridge request.
    }),
  ];

  pi.on('session_start', () => {
    pi.events.emit(STATUS_PING, {}); // listeners are attached before this ping
  });
  pi.on('session_shutdown', () => {
    outputRequest('output:unsubscribe');
    owner = undefined;
    pendingAgentRequests.clear();
    for (const stop of off) stop();
  });

  void sendAuthorizedAgentRequest; // call only for an externally authorized command
  // Call outputRequest('output:subscribe') again before the five-minute lease expires.
}
```

A bridge must not turn this bus into a remote conversation API. The implemented conversation operations are rejection-only, attention replies are rejection-only, queue depth is unknown, and approvals cannot be answered or simulated through this contract.

## Implementation sources

The documented contract is implemented in:

- [events-contract.ts](../src/events-contract.ts) — channels, envelopes, flags, limits, operations, and fixed errors.
- [events-requests.ts](../src/events-requests.ts) — request parsing, idempotency, deadlines, capacity, and terminal lifecycle.
- [owner-events.ts](../src/owner-events.ts) — owner/main/attention metadata and unsupported-operation rejection.
- [output-events.ts](../src/output-events.ts) — opt-in output subscriptions and bounded recovery.
- [events-controls.ts](../src/events-controls.ts) — authorized controls, history pages, cursors, and selected results.
- [agent-status.ts](../src/agent-status.ts) — the separate background-agent status capability/snapshot.
- [index.ts](../src/index.ts) — owner lifecycle wiring and the two default-off CLI flags.
