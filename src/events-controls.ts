/**
 * Authorized, owner-scoped control requests and bounded reads for OptChat
 * background agents.
 *
 * The adapter validates ownership and run generation before the generic
 * request tracker accepts a request. It reuses Children's public spawn,
 * tell, stop, and retained methods and never imports or mutates its private
 * registries.
 *
 * History reads use only the public sessionManager.getBranch() projection.
 * Pi may copy or read that existing source in full: these bounds constrain
 * the new snapshots/results, not SDK source I/O. If a hard source-read limit
 * is required, archived run results should be deferred rather than served by
 * hand-rolled filesystem streaming.
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_REQUEST_EVENT,
  EVENT_LIMITS,
  HISTORY_REQUEST_EVENT,
  type EventErrorCode,
  type EventRequestV1,
  type HistoryPageV1,
  type HistoryRunResultV1,
  type JsonValueV1,
} from './events-contract.ts';
import {
  createRequestTracker,
  requestListener,
  type EventDispatchResult,
  type RequestTimer,
} from './events-requests.ts';
import type { Task } from './agents.ts';
import { THINKING } from './profiles.ts';
import { isActiveRun, type RunInfo } from './runs.ts';

export type ControlThinking = typeof THINKING[number];

export interface ControlModel {
  readonly name: string;
  readonly thinking: readonly ControlThinking[];
}

/** Structural view of the public session branch; no private session state is used. */
export interface ControlSessionEntry {
  readonly type: string;
  readonly id: string;
  readonly message?: {
    readonly role: string;
    readonly content?: unknown;
  };
}

/** Structural view of a public retained Pi message. */
export interface ControlRetainedMessage {
  readonly role: string;
  readonly content?: unknown;
}

export interface ControlLiveRun {
  readonly info: RunInfo;
}

export interface ControlChildren {
  readonly ids: readonly string[];
  readonly history: { readonly records: ReadonlyMap<string, RunInfo> };
  live(id: string): ControlLiveRun | undefined;
  /** Public retained-message read. It may read the source in full. */
  retained(id: string): readonly ControlRetainedMessage[];
  spawn(tasks: Task[], cwd: string, signal?: AbortSignal, parentId?: string, connected?: boolean): Promise<string[]>;
  tell(id: string, message: string, source?: 'manager' | 'user', caller?: string, options?: { allowResume?: boolean }): Promise<string>;
  stop(id: string): Promise<void>;
}

export interface EventControlsBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventControlsOptions {
  readonly bus: EventControlsBus;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly contentEnabled: boolean;
  readonly controlEnabled: boolean;
  readonly children: ControlChildren;
  /** The current owner's cwd. Request payloads cannot choose another cwd. */
  readonly cwd: string;
  /** Authenticated models and their supported thinking levels. */
  readonly models: () => readonly ControlModel[];
  /** Public current-session branch projection. Pi may copy/read the full source. */
  readonly branch: () => readonly ControlSessionEntry[];
  readonly maxAgents?: number;
  readonly subagentLevels?: number;
  readonly now?: () => number;
  readonly timer?: RequestTimer;
}

export interface EventControls {
  dispose(): void;
}

interface RunView {
  readonly run: RunInfo;
  readonly live: boolean;
}

interface HistoryItem {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly truncated: boolean;
}

interface HistorySnapshot {
  readonly items: readonly HistoryItem[];
  readonly omitted: number;
  readonly truncated: boolean;
}

interface CursorSnapshot {
  readonly id: string;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly clientId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly items: readonly HistoryItem[];
  readonly omitted: number;
  readonly truncated: boolean;
  readonly bytes: number;
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function characterBytes(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code <= 0xffff) return 3;
  return 4;
}

/** Truncate on a Unicode code-point boundary without copying the full source. */
function truncateText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  let bytes = 0;
  let text = '';
  for (const character of value) {
    const size = characterBytes(character);
    if (bytes + size > maxBytes) return { text, truncated: true };
    bytes += size;
    text += character;
  }
  return { text, truncated: false };
}

function runView(children: ControlChildren, id: string): RunView | undefined {
  const live = children.live(id)?.info;
  if (live) return { run: live, live: true };
  const run = children.history.records.get(id);
  return run ? { run, live: false } : undefined;
}

function topLevel(run: RunInfo): boolean {
  return !run.parentId && run.depth === 1 && run.connected !== true;
}

function finished(run: RunInfo): boolean {
  return ['completed', 'failed', 'stopped', 'interrupted'].includes(run.state);
}

/** Extract only plain text blocks. Images, thinking, tool calls, and errors are skipped. */
function boundedPlainText(content: unknown, maxBytes: number): { text: string; truncated: boolean } {
  if (typeof content === 'string') return truncateText(content, maxBytes);
  if (!Array.isArray(content)) return { text: '', truncated: false };
  const parts: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type !== 'text' || typeof candidate.text !== 'string' || candidate.text.length === 0) continue;
    const separator = parts.length > 0 ? 1 : 0;
    if (bytes + separator > maxBytes) {
      truncated = true;
      break;
    }
    const piece = truncateText(candidate.text, maxBytes - bytes - separator);
    if (piece.truncated) truncated = true;
    if (piece.text.length > 0) {
      parts.push(piece.text);
      bytes += separator + utf8Bytes(piece.text);
    }
    if (truncated) break;
  }
  return { text: parts.join('\n'), truncated };
}

function safeItemId(id: string, index: number): string {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : `entry-${index + 1}`;
}

/** Bound the complete serialized history item, including its id and JSON escaping. */
function boundedHistoryItem(id: string, role: 'user' | 'assistant', source: { text: string; truncated: boolean }): HistoryItem {
  const characters = Array.from(source.text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate: HistoryItem = {
      id,
      role,
      text: characters.slice(0, middle).join(''),
      truncated: source.truncated,
    };
    if (utf8Bytes(JSON.stringify(candidate)) <= EVENT_LIMITS.historyItemBytes) low = middle;
    else high = middle - 1;
  }
  const text = characters.slice(0, low).join('');
  return { id, role, text, truncated: source.truncated || text !== source.text };
}

/**
 * Project at most 200 public message entries from the current branch.
 * Non-message entries and non-user/assistant messages are never serialized.
 */
function projectBranch(entries: readonly ControlSessionEntry[]): HistorySnapshot {
  // Walk backward and retain at most the bounded candidate tail. Do not build
  // an unbounded derived array from the full public branch snapshot.
  const candidates: ControlSessionEntry[] = [];
  let firstCandidateIndex = entries.length;
  let candidateLimitReached = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== 'message' || !entry.message) continue;
    candidates.push(entry);
    firstCandidateIndex = index;
    if (candidates.length === EVENT_LIMITS.historyCandidates) {
      candidateLimitReached = true;
      break;
    }
  }
  candidates.reverse();
  let omitted = candidateLimitReached ? firstCandidateIndex : 0;
  const items: HistoryItem[] = [];

  for (const entry of candidates) {
    const message = entry.message;
    if (!message) {
      omitted += 1;
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      omitted += 1;
      continue;
    }
    const raw = boundedPlainText(message.content, EVENT_LIMITS.historyItemBytes);
    if (!raw.text) {
      omitted += 1;
      continue;
    }
    items.push(boundedHistoryItem(safeItemId(entry.id, items.length), message.role, raw));
  }

  return {
    items,
    omitted,
    truncated: omitted > 0 || items.some(item => item.truncated),
  };
}

function placeholderPage(
  ownerSessionId: string,
  ownerEpoch: string,
  items: readonly HistoryItem[],
  omitted: number,
  truncated: boolean,
): HistoryPageV1 {
  return {
    version: 1,
    ownerSessionId,
    ownerEpoch,
    scope: 'current-session-branch',
    items,
    nextCursor: '00000000-0000-4000-8000-000000000000',
    truncated,
    omitted,
  };
}

function historyResultWithinLimit(request: EventRequestV1, page: HistoryPageV1): boolean {
  // Include the shared terminal envelope, not only the page value.
  const envelope = {
    version: 1,
    clientId: request.clientId,
    requestId: request.requestId,
    ownerSessionId: request.ownerSessionId,
    ownerEpoch: request.ownerEpoch,
    operation: request.operation,
    phase: 'completed',
    sequence: 2,
    outcome: { status: 'ok', code: null, value: page },
  };
  return utf8Bytes(JSON.stringify(envelope)) <= EVENT_LIMITS.historyPageBytes;
}

/** Create the control adapter and its bounded idempotent request listener. */
export function createEventControls(options: EventControlsOptions): EventControls {
  const now = options.now ?? Date.now;
  const timer: RequestTimer = options.timer ?? {
    set(callback, delayMs) { return setTimeout(callback, delayMs); },
    clear(handle) { if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout); },
  };
  const cursors = new Map<string, CursorSnapshot>();
  let cursorBytes = 0;
  let cursorTimer: unknown;

  function purgeCursors(): void {
    const current = now();
    for (const [id, snapshot] of cursors) {
      if (snapshot.expiresAt > current) continue;
      cursors.delete(id);
      cursorBytes -= snapshot.bytes;
    }
    if (cursorBytes < 0) cursorBytes = 0;
  }

  function scheduleCursorTimer(): void {
    if (cursorTimer !== undefined) {
      timer.clear(cursorTimer);
      cursorTimer = undefined;
    }
    if (cursors.size === 0) return;
    let expiry = Number.POSITIVE_INFINITY;
    for (const snapshot of cursors.values()) expiry = Math.min(expiry, snapshot.expiresAt);
    const delay = Math.max(0, expiry - now());
    cursorTimer = timer.set(() => {
      cursorTimer = undefined;
      purgeCursors();
      scheduleCursorTimer();
    }, delay);
  }

  function removeCursor(id: string): void {
    const snapshot = cursors.get(id);
    if (!snapshot) return;
    cursors.delete(id);
    cursorBytes -= snapshot.bytes;
    if (cursorBytes < 0) cursorBytes = 0;
  }

  function cursorPayloadBytes(items: readonly HistoryItem[], omitted: number, truncated: boolean): number {
    return utf8Bytes(JSON.stringify({ items, omitted, truncated }));
  }

  /** Cache a bounded continuation and evict the oldest snapshots as needed. */
  function cacheCursor(request: EventRequestV1, snapshot: HistorySnapshot): { id: string; omitted: number; truncated: boolean } | null {
    if (snapshot.items.length === 0) return null;
    purgeCursors();

    const accepted: HistoryItem[] = [];
    let omitted = snapshot.omitted;
    let truncated = snapshot.truncated;
    for (const item of snapshot.items) {
      const candidate = [...accepted, item];
      if (cursorPayloadBytes(candidate, omitted, truncated) > EVENT_LIMITS.historyCursorBytes) {
        omitted += snapshot.items.length - accepted.length;
        truncated = true;
        break;
      }
      accepted.push(item);
    }
    if (accepted.length === 0) return null;
    let bytes = cursorPayloadBytes(accepted, omitted, truncated);
    while (bytes > EVENT_LIMITS.historyCursorBytes && accepted.length > 0) {
      accepted.pop();
      omitted += 1;
      truncated = true;
      bytes = cursorPayloadBytes(accepted, omitted, truncated);
    }
    if (accepted.length === 0) return null;

    while (cursors.size >= EVENT_LIMITS.historyCursors || cursorBytes + bytes > EVENT_LIMITS.historyCursorBytes) {
      const oldest = cursors.values().next().value as CursorSnapshot | undefined;
      if (!oldest) break;
      removeCursor(oldest.id);
    }

    const id = randomUUID();
    const createdAt = now();
    const record: CursorSnapshot = {
      id,
      ownerSessionId: request.ownerSessionId,
      ownerEpoch: request.ownerEpoch,
      clientId: request.clientId,
      createdAt,
      expiresAt: createdAt + EVENT_LIMITS.historyCursorTtlMs,
      items: accepted,
      omitted,
      truncated,
      bytes,
    };
    cursors.set(id, record);
    cursorBytes += bytes;
    scheduleCursorTimer();
    return { id, omitted, truncated };
  }

  function cursorProblem(request: Extract<EventRequestV1, { operation: 'history:recent' }>): EventErrorCode | undefined {
    const cursor = request.payload.cursor;
    if (!cursor) return undefined;
    const snapshot = cursors.get(cursor);
    if (!snapshot) return 'NOT_FOUND';
    if (snapshot.expiresAt <= now()) return 'NOT_FOUND';
    if (snapshot.ownerSessionId !== request.ownerSessionId || snapshot.ownerEpoch !== request.ownerEpoch) return 'STALE_OWNER';
    if (snapshot.clientId !== request.clientId) return 'POLICY_DENIED';
    return undefined;
  }

  function selectedRunProblem(request: Extract<EventRequestV1, { operation: 'history:result' }>): EventErrorCode | undefined {
    const view = runView(options.children, request.payload.runId);
    if (!view) return 'NOT_FOUND';
    if (!topLevel(view.run)) return 'POLICY_DENIED';
    if (view.run.started !== request.payload.expectedStartedAt) return 'STALE_RUN';
    return undefined;
  }

  const validate = (request: EventRequestV1): EventErrorCode | undefined => {
    if (request.operation === 'agent:spawn') {
      if (options.subagentLevels !== undefined && options.subagentLevels < 1) return 'POLICY_DENIED';
      const catalog = options.models();
      for (const task of request.payload.tasks) {
        if (!task.model || !task.thinking) return 'INVALID_REQUEST';
        const model = catalog.find(candidate => candidate.name === task.model);
        if (!model) return 'NOT_FOUND';
        if (!model.thinking.includes(task.thinking as ControlThinking)) return 'POLICY_DENIED';
      }
      if (options.maxAgents !== undefined && options.children.ids.length + request.payload.tasks.length > options.maxAgents) return 'CAPACITY';
      return undefined;
    }
    if (request.operation === 'agent:steer' || request.operation === 'agent:stop' || request.operation === 'agent:resume') {
      const view = runView(options.children, request.payload.runId);
      if (!view) return 'NOT_FOUND';
      if (!topLevel(view.run)) return 'POLICY_DENIED';
      if (view.run.started !== request.payload.expectedStartedAt) return 'STALE_RUN';
      if (request.operation === 'agent:steer') {
        return view.live && view.run.state === 'running' ? undefined : 'INVALID_STATE';
      }
      if (request.operation === 'agent:stop') {
        return view.live && isActiveRun(view.run) ? undefined : 'INVALID_STATE';
      }
      return !view.live && finished(view.run) ? undefined : 'INVALID_STATE';
    }
    if (request.operation === 'history:recent') return cursorProblem(request);
    if (request.operation === 'history:result') return selectedRunProblem(request);
    return 'UNSUPPORTED_API';
  };

  const dispatch = async (request: EventRequestV1, context: { signal: AbortSignal }): Promise<EventDispatchResult> => {
    const problem = validate(request);
    if (problem) return { ok: false, code: problem };
    if (context.signal.aborted) return { ok: false, code: 'OWNER_CLOSING' };

    if (request.operation === 'agent:spawn') {
      const tasks: Task[] = request.payload.tasks.map(task => ({
        task: task.task,
        model: task.model as string,
        thinking: task.thinking as Task['thinking'],
      }));
      try {
        const runIds = await options.children.spawn(tasks, options.cwd, context.signal, undefined, false);
        const value: JsonValueV1 = { runIds };
        return { ok: true, value };
      } catch {
        return { ok: false, code: validate(request) ?? 'INTERNAL_ERROR' };
      }
    }

    if (request.operation === 'agent:steer') {
      try {
        // The validated live run and this call are in the same synchronous turn.
        // allowResume:false keeps a completion race from becoming an implicit resume.
        await options.children.tell(request.payload.runId, request.payload.message, 'manager', undefined, { allowResume: false });
        const value: JsonValueV1 = { runId: request.payload.runId, accepted: 'steered' };
        return { ok: true, value };
      } catch {
        return { ok: false, code: validate(request) ?? 'INTERNAL_ERROR' };
      }
    }

    if (request.operation === 'agent:stop') {
      try {
        await options.children.stop(request.payload.runId);
        // This records that stop was requested/awaited, not that the run exited.
        const value: JsonValueV1 = { runId: request.payload.runId, accepted: 'stop-requested' };
        return { ok: true, value };
      } catch {
        return { ok: false, code: validate(request) ?? 'INTERNAL_ERROR' };
      }
    }

    if (request.operation === 'agent:resume') {
      try {
        await options.children.tell(request.payload.runId, request.payload.message, 'manager');
        const value: JsonValueV1 = { runId: request.payload.runId, accepted: 'resumed' };
        return { ok: true, value };
      } catch {
        return { ok: false, code: validate(request) ?? 'INTERNAL_ERROR' };
      }
    }

    if (request.operation === 'history:recent') {
      try {
        purgeCursors();
        let source: HistorySnapshot;
        if (request.payload.cursor) {
          const cached = cursors.get(request.payload.cursor);
          if (!cached || cached.expiresAt <= now()) return { ok: false, code: 'NOT_FOUND' };
          if (cached.ownerSessionId !== request.ownerSessionId || cached.ownerEpoch !== request.ownerEpoch) return { ok: false, code: 'STALE_OWNER' };
          if (cached.clientId !== request.clientId) return { ok: false, code: 'POLICY_DENIED' };
          source = { items: cached.items, omitted: cached.omitted, truncated: cached.truncated };
        } else {
          source = projectBranch(options.branch());
        }

        const limit = request.payload.limit ?? EVENT_LIMITS.historyItems;
        const selected: HistoryItem[] = [];
        let index = 0;
        for (; index < source.items.length; index += 1) {
          if (selected.length >= limit) break;
          const candidate = [...selected, source.items[index]];
          const measurement = placeholderPage(
            request.ownerSessionId,
            request.ownerEpoch,
            candidate,
            // Reserve enough digits for the final omission count as well.
            source.omitted + source.items.length,
            source.truncated,
          );
          if (!historyResultWithinLimit(request, measurement)) break;
          selected.push(source.items[index]);
        }

        const remaining = source.items.slice(index);
        // Deferred items remain available through the continuation. Only
        // entries permanently lost by projection or cache bounds are omitted.
        const continuation: HistorySnapshot = {
          items: remaining,
          omitted: source.omitted,
          truncated: source.truncated,
        };
        const cached = cacheCursor(request, continuation);
        const page: HistoryPageV1 = {
          version: 1,
          ownerSessionId: request.ownerSessionId,
          ownerEpoch: request.ownerEpoch,
          scope: 'current-session-branch',
          items: selected,
          nextCursor: cached?.id ?? null,
          truncated: cached?.truncated ?? continuation.truncated,
          omitted: cached?.omitted ?? continuation.omitted,
        };
        if (!historyResultWithinLimit(request, page)) return { ok: false, code: 'INTERNAL_ERROR' };
        return { ok: true, value: page as unknown as JsonValueV1 };
      } catch {
        return { ok: false, code: 'INTERNAL_ERROR' };
      }
    }

    if (request.operation === 'history:result') {
      const view = runView(options.children, request.payload.runId);
      if (!view) return { ok: false, code: 'NOT_FOUND' };
      if (!topLevel(view.run)) return { ok: false, code: 'POLICY_DENIED' };
      if (view.run.started !== request.payload.expectedStartedAt) return { ok: false, code: 'STALE_RUN' };
      if (!finished(view.run)) {
        const result: HistoryRunResultV1 = {
          version: 1,
          runId: view.run.id,
          state: view.run.state,
          ready: false,
          text: '',
          truncated: false,
        };
        return { ok: true, value: result as unknown as JsonValueV1 };
      }
      try {
        // Children.retained is public, but may read/copy its source in full.
        const messages = options.children.retained(view.run.id);
        let assistant: ControlRetainedMessage | undefined;
        for (const message of messages) {
          if (message.role === 'assistant') assistant = message;
        }
        const bounded = assistant
          ? boundedPlainText(assistant.content, EVENT_LIMITS.runResultTextBytes)
          : { text: '', truncated: false };
        const result: HistoryRunResultV1 = {
          version: 1,
          runId: view.run.id,
          state: view.run.state,
          ready: true,
          text: bounded.text,
          truncated: bounded.truncated,
        };
        return { ok: true, value: result as unknown as JsonValueV1 };
      } catch {
        return { ok: false, code: 'INTERNAL_ERROR' };
      }
    }

    return { ok: false, code: 'UNSUPPORTED_API' };
  };

  const tracker = createRequestTracker({
    ownerEpoch: options.ownerEpoch,
    ownerSessionId: options.ownerSessionId,
    bus: options.bus,
    dispatch,
    contentEnabled: options.contentEnabled,
    controlEnabled: options.controlEnabled,
    validate,
    now: options.now,
    timer: options.timer,
  });
  const stopAgent = options.bus.on(AGENT_REQUEST_EVENT, requestListener(tracker));
  const stopHistory = options.bus.on(HISTORY_REQUEST_EVENT, requestListener(tracker));

  return {
    dispose() {
      try { stopAgent(); } catch { /* an unsubscribe failure must not block cleanup */ }
      try { stopHistory(); } catch { /* an unsubscribe failure must not block cleanup */ }
      if (cursorTimer !== undefined) {
        timer.clear(cursorTimer);
        cursorTimer = undefined;
      }
      cursors.clear();
      cursorBytes = 0;
      tracker.dispose();
    },
  };
}
