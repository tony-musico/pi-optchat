/**
 * Live agent status for other extensions in the same Pi process.
 *
 * The profile owner publishes a bounded snapshot of its background agents on Pi's in-process event bus. The snapshot is observation only: it carries no task text, no title, no path, no transcript, no tool arguments and no tool output, and nothing here can control an agent.
 */
import { isHandingOff, isRunning, type RunInfo, type RunState } from './runs.ts';
import { elapsed } from './inspector.ts';
import type { IntegrationsCapabilityV1 } from './events-contract.ts';

/** The channels this extension publishes on. They are literal strings: a host may hard-code them. */
export const STATUS_EVENT = 'optchat:status:v1';
export const CAPABILITIES_EVENT = 'optchat:capabilities:v1';
export const PING_EVENT = 'optchat:status:ping:v1';

/** The payload version of both channels. A change that breaks this needs a new channel and version. */
export const STATUS_VERSION = 1;
/** How many agents one snapshot may list. The counts stay exact beyond it. */
export const MAX_AGENTS = 64;
/** The shortest gap between two publications, in milliseconds. */
export const MIN_INTERVAL_MS = 250;

/** The fields one agent row may carry. A host may ignore any of them, and may ignore fields it does not know. */
export const STATUS_FIELDS = ['runId', 'state', 'handingOff', 'model', 'elapsed', 'currentTool', 'lastActivityAt', 'parentId', 'depth'] as const;

/** Every string a snapshot may carry has a bound and a syntax. Anything else is left out rather than published. */
const LIMITS = { profile: 128, session: 128, run: 128, model: 256, tool: 128, elapsed: 64 } as const;
/** Profile names are directories: lowercase letters, digits, hyphens and underscores. */
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Session ids are Pi's own: identifier characters, no spaces. */
const SESSION = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** Run ids are OptChat's own: the first eight characters of a UUID, or an id read back from disk. */
const RUN = /^[A-Za-z0-9-]{1,128}$/;
/** A model is `provider/id`. Identifier characters only, never a display name. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
/** A tool is a name like `bash` or `read`. Identifier characters only, never a display name. */
const TOOL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** What `elapsed()` returns. */
const ELAPSED = /^\d{1,12}s$|^\d{1,12}m \d{1,2}s$/;

export interface StatusAgentV1 {
  /** The run's opaque id. */
  runId: string;
  /** The run's own state, as OptChat records it. */
  state: RunState;
  /** The run has ended but its handoff summary has not reached the main agent yet. */
  handingOff: boolean;
  /** The model the run uses, or null when it cannot be published safely. */
  model: string | null;
  /** How long the run has been going, sampled when the snapshot was taken. */
  elapsed: string;
  /** The name of the tool the run is running now, or null. Never its arguments or output. */
  currentTool: string | null;
  /** When the run last did something, or null when that is unknown. */
  lastActivityAt: number | null;
  /** The run's parent, or null. The parent may be missing from the snapshot when the cap cut it. */
  parentId: string | null;
  /** How deep the run is: 1 for a child of the main agent. */
  depth: number;
}

export interface StatusCountsV1 {
  /** Runs that are running, waiting for children, or stopping. */
  active: number;
  /** Runs that are paused, waiting for the user. */
  paused: number;
  /** Runs that have ended but still owe a handoff. */
  handingOff: number;
  /** Every run the snapshot counted, including the ones the cap left out. */
  total: number;
  /** How many counted runs the cap left out. */
  omitted: number;
}

export interface StatusV1 {
  version: 1;
  /** The profile's name, never its directory. */
  profile: string;
  /** The owner session's id, never a session file. */
  ownerSessionId: string;
  /** When the snapshot was taken, in epoch milliseconds. */
  sampledAt: number;
  counts: StatusCountsV1;
  agents: StatusAgentV1[];
}

export interface StatusCapabilitiesV1 {
  version: 1;
  profile: string;
  ownerSessionId: string;
  events: { status: string; capabilities: string; ping: string };
  status: {
    version: 1;
    scope: 'profile-owner';
    inProcessOnly: true;
    observationOnly: true;
    maxAgents: number;
    minIntervalMs: number;
    fields: readonly string[];
    /** Titles are never published: OptChat has no way to tell a safe title from task text. */
    titles: false;
  };
  /** Optional additive metadata for the capability-gated events integration. */
  integrations?: IntegrationsCapabilityV1;
}

/** What a live run is doing right now. */
export interface StatusLive {
  /** When the run last did something. */
  updated: number;
  /** The tools the run is running now, keyed by tool call id. */
  tools: ReadonlyMap<string, { name: string; started: number }>;
}

/** Where a snapshot comes from. OptChat's own `Children` satisfies this. */
export interface StatusSource {
  /** The profile's runs, in the order OptChat lists them. */
  list(): RunInfo[];
  /** What a run is doing now, if it is live. */
  live(id: string): StatusLive | undefined;
}

/** Pi's in-process event bus, as the extension API exposes it. */
export interface StatusBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** A timer the publisher can be tested with. */
export interface StatusTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

/**
 * Pi's event bus, when this Pi has one. An older Pi has none, and OptChat then publishes nothing rather than failing to start.
 */
export function statusBus(bus: unknown): StatusBus | undefined {
  const candidate = bus as Partial<StatusBus> | undefined;
  if (!candidate || typeof candidate.emit !== 'function' || typeof candidate.on !== 'function') return undefined;
  return { emit: candidate.emit.bind(candidate), on: candidate.on.bind(candidate) };
}

export interface StatusPublisherOptions {
  bus: StatusBus;
  source: StatusSource;
  profile: string;
  ownerSessionId: string;
  /** Additive integrations metadata, when an owner coordinator is present. */
  integrations?: IntegrationsCapabilityV1;
  /** Told when the fleet changes; returns an unsubscribe. */
  subscribe?: (listener: () => void) => () => void;
  now?: () => number;
  timer?: StatusTimer;
  minIntervalMs?: number;
  maxAgents?: number;
  /** Told about a failure to publish. Never about the payload. */
  warn?: (message: string) => void;
}

export interface StatusPublisher {
  /** Publish the current status again, within the coalescing window. */
  replay(): void;
  /** Stop publishing. Safe to call more than once. */
  dispose(): void;
}

export interface ProjectionOptions {
  profile: string;
  ownerSessionId: string;
  /** The time the snapshot is sampled at, in epoch milliseconds. */
  now: number;
  maxAgents?: number;
}

const timer: StatusTimer = {
  set(callback, delayMs) { const handle = setTimeout(callback, delayMs); handle.unref?.(); return handle; },
  clear(handle) { if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout); },
};

/** A string that is safe to publish: right syntax and within its bound, or nothing. */
function safe(value: unknown, pattern: RegExp, limit: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) return null;
  return pattern.test(value) ? value : null;
}

/** A number that is safe to publish, or null. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The tool a run is running now: the most recently started one. Ties are broken by the tool call id, which is never published.
 */
export function currentTool(live: StatusLive | undefined): string | null {
  if (!live) return null;
  let best: { key: string; name: string; started: number } | undefined;
  for (const [key, tool] of live.tools) {
    const started = finite(tool?.started) ?? 0;
    if (!best || started > best.started || (started === best.started && key < best.key)) best = { key, name: tool?.name ?? '', started };
  }
  if (!best) return null;
  return safe(best.name, TOOL, LIMITS.tool);
}

/**
 * A snapshot of the owner's fleet. Returns nothing when an identity cannot be published safely: a partial fleet would misreport the counts.
 */
export function projectStatus(source: StatusSource, options: ProjectionOptions): StatusV1 | undefined {
  const profile = safe(options.profile, PROFILE, LIMITS.profile);
  const ownerSessionId = safe(options.ownerSessionId, SESSION, LIMITS.session);
  const sampledAt = finite(options.now);
  if (!profile || !ownerSessionId || sampledAt === null) return undefined;
  const cap = Math.max(0, Math.min(options.maxAgents ?? MAX_AGENTS, MAX_AGENTS));
  const eligible = source.list().filter(run => isRunning(run) || run.state === 'paused' || isHandingOff(run));
  const agents: StatusAgentV1[] = [];
  for (const run of eligible.slice(0, cap)) {
    const runId = safe(run.id, RUN, LIMITS.run);
    if (!runId) return undefined;
    const live = source.live(runId);
    const started = finite(run.started) ?? 0;
    const ended = finite(run.ended);
    const since = elapsed(Math.max(0, (ended ?? sampledAt) - started));
    agents.push({
      runId,
      state: run.state,
      handingOff: isHandingOff(run),
      model: safe(run.model, MODEL, LIMITS.model),
      elapsed: ELAPSED.test(since) ? since : '0s',
      currentTool: currentTool(live),
      lastActivityAt: live ? finite(live.updated) : ended,
      parentId: run.parentId ? safe(run.parentId, RUN, LIMITS.run) : null,
      depth: Number.isInteger(run.depth) ? run.depth : 1,
    });
  }
  return {
    version: STATUS_VERSION,
    profile,
    ownerSessionId,
    sampledAt,
    counts: {
      active: eligible.filter(run => isRunning(run)).length,
      paused: eligible.filter(run => run.state === 'paused').length,
      handingOff: eligible.filter(run => isHandingOff(run)).length,
      total: eligible.length,
      omitted: eligible.length - agents.length,
    },
    agents,
  };
}

/** What the owner can do, so a host knows what it may expect. */
export function statusCapabilities(profile: string, ownerSessionId: string, options: { maxAgents?: number; minIntervalMs?: number; integrations?: IntegrationsCapabilityV1 } = {}): StatusCapabilitiesV1 | undefined {
  const name = safe(profile, PROFILE, LIMITS.profile);
  const session = safe(ownerSessionId, SESSION, LIMITS.session);
  if (!name || !session) return undefined;
  const base: StatusCapabilitiesV1 = {
    version: STATUS_VERSION,
    profile: name,
    ownerSessionId: session,
    events: { status: STATUS_EVENT, capabilities: CAPABILITIES_EVENT, ping: PING_EVENT },
    status: {
      version: STATUS_VERSION,
      scope: 'profile-owner',
      inProcessOnly: true,
      observationOnly: true,
      maxAgents: Math.max(0, Math.min(options.maxAgents ?? MAX_AGENTS, MAX_AGENTS)),
      minIntervalMs: Math.max(0, options.minIntervalMs ?? MIN_INTERVAL_MS),
      fields: STATUS_FIELDS,
      titles: false,
    },
  };
  if (!options.integrations) return base;
  return {
    version: STATUS_VERSION,
    profile: name,
    ownerSessionId: session,
    events: { status: STATUS_EVENT, capabilities: CAPABILITIES_EVENT, ping: PING_EVENT },
    status: {
      version: STATUS_VERSION,
      scope: 'profile-owner',
      inProcessOnly: true,
      observationOnly: true,
      maxAgents: Math.max(0, Math.min(options.maxAgents ?? MAX_AGENTS, MAX_AGENTS)),
      minIntervalMs: Math.max(0, options.minIntervalMs ?? MIN_INTERVAL_MS),
      fields: STATUS_FIELDS,
      titles: false,
    },
    integrations: options.integrations,
  };
}

/** What a host can compare: sampledAt and elapsed drift are not a change. */
export function statusKey(status: StatusV1): string {
  return JSON.stringify({
    profile: status.profile,
    ownerSessionId: status.ownerSessionId,
    counts: status.counts,
    agents: status.agents.map(agent => [agent.runId, agent.state, agent.handingOff, agent.model, agent.currentTool, agent.lastActivityAt, agent.parentId, agent.depth]),
  });
}

/**
 * Publishes the owner's fleet on Pi's event bus: once when it starts, then whenever the fleet changes, at most once per interval.
 *
 * Disposal is final: nothing is published after it, and a timer that was already scheduled does nothing when it fires.
 */
export function createStatusPublisher(options: StatusPublisherOptions): StatusPublisher {
  const clock = options.now ?? (() => Date.now());
  const scheduler = options.timer ?? timer;
  const warn = options.warn ?? (() => {});
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? MIN_INTERVAL_MS);
  const maxAgents = Math.max(0, Math.min(options.maxAgents ?? MAX_AGENTS, MAX_AGENTS));
  let disposed = false;
  let publishing = false;
  let dirty = false;
  let forced = false;
  let scheduled = false;
  let handle: unknown;
  let deadline = 0;
  let lastPublishedAt = 0;
  let lastKey = '';
  let published = false;
  const told = new Set<string>();

  const complain = (message: string) => {
    if (told.has(message) || told.size >= 5) return;
    told.add(message);
    try { warn(message); } catch { /* a broken warning channel must not stop status */ }
  };
  /**
   * A failure is reported by what failed, never by what it said: an error may carry task text, a path or a bus payload, and a warning reaches the screen and the log.
   */
  const fixed = (what: string) => `OptChat could not publish agent status: ${what}.`;
  const emit = (channel: string, data: unknown) => {
    try { options.bus.emit(channel, data); }
    catch { complain(fixed('the event bus refused the message')); }
  };
  const publish = (force: boolean) => {
    const capabilities = statusCapabilities(options.profile, options.ownerSessionId, { maxAgents, minIntervalMs, integrations: options.integrations });
    if (!capabilities) { complain(fixed('the profile or session identity is not publishable')); return; }
    let status: StatusV1 | undefined;
    try { status = projectStatus(options.source, { profile: options.profile, ownerSessionId: options.ownerSessionId, now: clock(), maxAgents }); }
    catch { complain(fixed('the agents could not be read')); return; }
    // Nothing is advertised without a snapshot to go with it: a host that sees capabilities expects a status.
    if (!status) { complain(fixed('an agent identity is not publishable')); return; }
    const key = statusKey(status);
    if (!force && published && key === lastKey) return;
    emit(CAPABILITIES_EVENT, capabilities);
    emit(STATUS_EVENT, status);
    lastKey = key;
    published = true;
  };
  const flush = () => {
    if (disposed) return;
    scheduled = false;
    handle = undefined;
    const force = forced;
    forced = false;
    lastPublishedAt = clock();
    publishing = true;
    try { publish(force); }
    catch { complain(fixed('the status could not be built')); }
    finally { publishing = false; }
    if (dirty) { dirty = false; schedule(false); }
  };
  /** A flush is anchored to the last publication: later activity cannot push it further away. */
  const schedule = (force: boolean) => {
    if (disposed) return;
    if (force) forced = true;
    const at = clock();
    const target = Math.max(at, lastPublishedAt + minIntervalMs);
    if (scheduled) { deadline = Math.min(deadline, target); return; }
    deadline = target;
    scheduled = true;
    try { handle = scheduler.set(() => { handle = undefined; flush(); }, Math.max(0, deadline - at)); }
    catch { scheduled = false; complain(fixed('the status could not be scheduled')); }
  };
  const changed = () => {
    if (disposed) return;
    try {
      if (publishing) { dirty = true; return; }
      schedule(false);
    } catch { complain('OptChat could not watch its agents.'); }
  };
  /** A ping asks for the current status again. Its payload is ignored: it is not a request with arguments. */
  const pinged = () => {
    if (disposed) return;
    try { schedule(true); }
    catch { complain('OptChat could not answer a status ping.'); }
  };

  const stopPing = options.bus.on(PING_EVENT, pinged);
  const stopChanges = options.subscribe?.(changed);
  lastPublishedAt = clock();
  publishing = true;
  try { publish(true); }
  catch { complain(fixed('the status could not be built')); }
  finally { publishing = false; }
  if (dirty) { dirty = false; schedule(false); }

  return {
    replay() { schedule(true); },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduled = false;
      dirty = false;
      forced = false;
      if (handle !== undefined) { scheduler.clear(handle); handle = undefined; }
      try { stopChanges?.(); } catch { /* an unsubscribe that throws must not block the rest */ }
      try { stopPing(); } catch { /* an unsubscribe that throws must not block the rest */ }
    },
  };
}
