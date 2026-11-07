# Live agent status

OptChat publishes what its background agents are doing on Pi's in-process event bus, so another extension in the same Pi process can show it without importing OptChat, reading its files or talking to an agent.

For the separately implemented, capability-gated main-agent, output, agent-control, and history integrations, see the [Pi events integration guide](events-integration.md). Those integrations do not change the observation-only meaning of the background-agent status contract below.

## Scope

- **In-process only.** The bus belongs to the Pi process. A second terminal, a `pi -p` run and a connected window see nothing.
- **The owner publishes.** The owner is the Pi process that opened the profile. A connected window, a joined run and a plain Pi session publish nothing.
- **Observation only.** Nothing in this three-channel background-agent status contract can start, steer or stop an agent. The separate event integrations require their own independent flags.
- **No authentication.** Every extension in the process is trusted, as they already are.

## Channels

| Channel | Direction | Payload |
| --- | --- | --- |
| `optchat:capabilities:v1` | owner → host | What the owner offers. |
| `optchat:status:v1` | owner → host | The current snapshot. |
| `optchat:status:ping:v1` | host → owner | Nothing. The payload is ignored. |

A host that arrives late asks for the current status with a ping; the owner answers with capabilities and then a status.

## Capabilities

```json
{
  "version": 1,
  "profile": "work",
  "ownerSessionId": "0198f3c2-1a2b-7c3d-8e9f-0123456789ab",
  "events": {
    "status": "optchat:status:v1",
    "capabilities": "optchat:capabilities:v1",
    "ping": "optchat:status:ping:v1"
  },
  "status": {
    "version": 1,
    "scope": "profile-owner",
    "inProcessOnly": true,
    "observationOnly": true,
    "maxAgents": 64,
    "minIntervalMs": 250,
    "fields": ["runId", "state", "handingOff", "model", "elapsed", "currentTool", "lastActivityAt", "parentId", "depth", "startedAt"],
    "titles": false
  }
}
```

Capabilities always arrive before the status that belongs to them. A host that meets a version it does not know ignores what it gets; fields it does not know are ignored as well. A change that breaks this contract needs a new channel and a new version.

When the owner coordinator is present, capabilities also contain an additive `integrations` object describing the owner epoch, the independent content/control consent flags, unsupported operations, and finite limits. `status.observationOnly: true` continues to describe only this background-agent snapshot contract; see the [event integration guide](events-integration.md) for the separately gated families.

## Status

```json
{
  "version": 1,
  "profile": "work",
  "ownerSessionId": "0198f3c2-1a2b-7c3d-8e9f-0123456789ab",
  "sampledAt": 1760000000000,
  "counts": { "active": 1, "paused": 0, "handingOff": 0, "total": 1, "omitted": 0 },
  "agents": [
    {
      "runId": "8ab62e89",
      "state": "running",
      "handingOff": false,
      "model": "anthropic/claude-haiku-4-5",
      "elapsed": "3m 5s",
      "currentTool": "bash",
      "lastActivityAt": 1760000000000,
      "parentId": null,
      "depth": 1,
      "startedAt": 1759999980000
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `version` | 1. |
| `profile` | The profile's name, never its directory. |
| `ownerSessionId` | The owner session's id, never a session file. |
| `sampledAt` | When the snapshot was taken, in epoch milliseconds. |
| `counts.active` | Runs that are running, waiting for children, or stopping. |
| `counts.paused` | Runs that are paused, waiting for the user. |
| `counts.handingOff` | Finished runs whose handoff summary has not reached the main agent yet. |
| `counts.total` | Every counted run, including the ones the cap left out. |
| `counts.omitted` | Counted runs the 64-row cap left out. |
| `agents[].runId` | The run's opaque id. |
| `agents[].state` | `running`, `waiting`, `stopping`, `paused`, `completed`, `failed`, `stopped` or `interrupted`. |
| `agents[].handingOff` | The run has ended but still owes a handoff. |
| `agents[].model` | `provider/id`, or null when it cannot be published safely. |
| `agents[].elapsed` | How long the run has been going, sampled when the snapshot was taken. |
| `agents[].currentTool` | The name of the tool it is running now, or null. Never its arguments or output. |
| `agents[].lastActivityAt` | When it last did something, or null when that is unknown. |
| `agents[].parentId` | Its parent, or null. The parent may be missing from the list when the cap cut it. |
| `agents[].depth` | 1 for a child of the main agent. |
| `agents[].startedAt` | When the run started, in epoch milliseconds, or null when it cannot be published safely. It is the run's generation token. |

The counts are exclusive: `active + paused + handingOff = total`. The list keeps the order OptChat lists agents in, so a parent comes before its children.

`startedAt` is the token that says which generation of a run a host is looking at. A host that sends it back as `expectedStartedAt` in an agent control request names exactly that generation; a request that carries an older value is refused with `STALE_RUN`. A resumed run keeps its id and starts a new generation, so its `startedAt` changes and the snapshot says so.

## What is never published

Task text, titles, working directories, session file paths, transcripts, guidance, reports, handoff summaries, tool arguments and tool output: nothing a person wrote to an agent. OptChat has no way to tell a safe title from task text, so titles are left out entirely. A model or a tool name that is not an identifier is left out (null) rather than published.

A failure is reported as a fixed line ("OptChat could not publish agent status: the agents could not be read."), never as the text that failed: an error may carry task text, a path or a bus payload.

## Bounds

- 64 agents per snapshot. The counts stay exact past that, and `counts.omitted` says how many rows were left out.
- Strings: profile and session id at most 128 characters, run id at most 128, model at most 256, tool name at most 128, elapsed at most 64.
- Identities are never shortened. An id that does not fit the rules stops the snapshot rather than being published partly, so the counts never lie.

## Timing

- The owner publishes once when the profile opens, then whenever the fleet changes, at most once every 250 ms. A busy fleet does not push its own publication away.
- Intermediate states can be missed. This is a status, not a log.
- A snapshot replaces the previous one. `elapsed` is sampled when the snapshot is taken; it does not keep ticking in the host.

## A host in a few lines

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const STATUS = 'optchat:status:v1';
const CAPABILITIES = 'optchat:capabilities:v1';
const PING = 'optchat:status:ping:v1';

export default function statusPanel(pi: ExtensionAPI) {
  let latest: { profile: string; ownerSessionId: string; active: number; total: number } | undefined;
  const off = [
    pi.events.on(CAPABILITIES, data => {
      const capabilities = data as { version: number };
      if (capabilities.version !== 1) return; // a version this host does not know
    }),
    pi.events.on(STATUS, data => {
      const status = data as { version: number; profile: string; ownerSessionId: string; counts: { active: number; total: number } };
      if (status.version !== 1) return;
      latest = { profile: status.profile, ownerSessionId: status.ownerSessionId, active: status.counts.active, total: status.counts.total };
    }),
  ];
  pi.on('session_start', () => { pi.events.emit(PING, {}); }); // ask the owner what is running
  pi.on('session_shutdown', () => { for (const stop of off) stop(); });
}
```

The host keeps the last snapshot keyed by profile and owner session, and drops it when that session ends. It polls nothing, reads no file and calls no agent.

## Limits to know

- Another process sees nothing: the bus is per Pi process.
- A host that starts after the owner published asks with a ping; the owner answers within 250 ms.
- When the owner shuts down, nothing more is published: there is no final "everything stopped" snapshot, and a Pi that is killed cannot send one. A host drops its cache when the owner's session ends.
- The owner publishes at most one snapshot every 250 ms, so a host that wants finer detail will not get it.
