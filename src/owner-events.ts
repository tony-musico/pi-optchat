/**
 * Owner-scoped metadata events for OptChat.
 *
 * The coordinator publishes lifecycle facts and a privacy-safe main-activity
 * snapshot on Pi's in-process event bus. It never sends input, answers UI
 * prompts, intercepts permissions, or publishes prompt/task text.
 */
import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_REQUEST_EVENT,
  CONVERSATION_RESULT_EVENT,
  EVENT_LIMITS,
  MAIN_PING_EVENT,
  MAIN_STATUS_EVENT,
  ATTENTION_EVENT,
  ATTENTION_REPLY_EVENT,
  ATTENTION_RESULT_EVENT,
  OWNER_EVENT,
  eventRequestResult,
  integrationsCapabilities,
  isIdentifier,
  parseEventRequest,
  type AttentionEventV1,
  type EventRequestResultV1,
  type IntegrationsCapabilityV1,
  type MainPhaseV1,
  type MainStatusV1,
  type OwnerEventV1,
} from './events-contract.ts';

export interface OwnerEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface OwnerEventTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface OwnerEventsOptions {
  readonly bus: OwnerEventBus;
  readonly ownerSessionId: string;
  readonly generation: number;
  readonly contentEnabled: boolean;
  readonly controlEnabled: boolean;
  readonly now?: () => number;
  readonly timer?: OwnerEventTimer;
  readonly minIntervalMs?: number;
  readonly epochFactory?: () => string;
  readonly idFactory?: () => string;
}

export interface OwnerEvents {
  readonly ownerEpoch: string;
  readonly generation: number;
  readonly capabilities: IntegrationsCapabilityV1;
  /** The current generated activity id, or null between activities. */
  currentTurnId(): string | null;
  /** Advertise this owner after the existing capabilities/status publisher is ready. */
  ready(): void;
  /** Replay the same owner identity without creating listeners or a new epoch. */
  replay(): void;
  /** Stop listeners and timers. A ready owner announces closing with its old epoch. */
  dispose(announce?: boolean): void;
  beginActivity(): void;
  observeAssistantText(): void;
  settle(): void;
  setPending(pending: boolean): void;
  toolStarted(callId: string, toolName: string): void;
  toolEnded(callId: string): void;
  attentionStarted(): void;
  attentionEnded(): void;
}

const defaultTimer: OwnerEventTimer = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
  },
};

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_OBSERVED_TOOLS = 32;
const MAX_OPEN_ATTENTION = 32;

interface ObservedTool {
  readonly name: string | null;
  readonly order: number;
}

/** A fresh owner identity and metadata coordinator. Request listeners attach in the constructor. */
export function createOwnerEvents(options: OwnerEventsOptions): OwnerEvents {
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? defaultTimer;
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? EVENT_LIMITS.metadataCoalesceMs);
  const epochFactory = options.epochFactory ?? randomUUID;
  const idFactory = options.idFactory ?? randomUUID;
  const requestedEpoch = epochFactory();
  const ownerEpoch = isIdentifier(requestedEpoch) ? requestedEpoch : randomUUID();

  let activityPhase: 'idle' | 'working' | 'responding' = 'idle';
  let turnId: string | null = null;
  let pending = false;
  let closing = false;
  let disposed = false;
  let readyPublished = false;
  let toolOrder = 0;
  let toolCountUnknown = false;
  const tools = new Map<string, ObservedTool>();
  const openAttention: string[] = [];
  let attentionAmbiguous = false;

  let timerHandle: unknown;
  let timerDue: number | undefined;
  let scheduled = false;
  let publishing = false;
  let dirty = false;
  let lastPublishedAt = 0;

  const safeEmit = (channel: string, data: unknown): void => {
    try { options.bus.emit(channel, data); }
    catch { /* event-bus failures are deliberately silent and carry no payload text */ }
  };

  const generatedId = (): string => {
    const candidate = idFactory();
    return isIdentifier(candidate) ? candidate : randomUUID();
  };

  const phase = (): MainPhaseV1 => {
    if (closing) return 'closing';
    if (openAttention.length > 0 || attentionAmbiguous) return 'awaiting-input';
    return activityPhase;
  };

  const currentTool = (): { name: string | null; count: number | null } => {
    let selected: ObservedTool | undefined;
    for (const tool of tools.values()) if (!selected || tool.order > selected.order) selected = tool;
    return { name: selected?.name ?? null, count: toolCountUnknown ? null : tools.size };
  };

  const mainStatus = (): MainStatusV1 => {
    const tool = currentTool();
    return Object.freeze({
      version: 1,
      ownerSessionId: options.ownerSessionId,
      ownerEpoch,
      phase: phase(),
      turnId,
      currentTool: tool.name,
      toolCount: tool.count,
      pending,
      queueDepth: null,
      exactQueueDepth: false,
      sampledAt: now(),
    });
  };

  const cancelTimer = (): void => {
    if (timerHandle !== undefined) {
      try { timer.clear(timerHandle); } catch { /* a broken timer must not stop cleanup */ }
      timerHandle = undefined;
      timerDue = undefined;
    }
    scheduled = false;
  };

  const publishMain = (): void => {
    if (disposed) return;
    lastPublishedAt = now();
    publishing = true;
    try { safeEmit(MAIN_STATUS_EVENT, mainStatus()); }
    finally { publishing = false; }
    if (dirty) {
      dirty = false;
      scheduleMain();
    }
  };

  const scheduleMain = (): void => {
    if (disposed) return;
    if (publishing) { dirty = true; return; }
    const at = now();
    const target = Math.max(at, lastPublishedAt + minIntervalMs);
    if (scheduled && timerDue !== undefined && timerDue <= target) return;
    if (scheduled) cancelTimer();
    scheduled = true;
    timerDue = target;
    try {
      timerHandle = timer.set(() => {
        timerHandle = undefined;
        timerDue = undefined;
        scheduled = false;
        if (disposed) return;
        publishMain();
      }, Math.max(0, target - at));
    } catch {
      scheduled = false;
      timerDue = undefined;
    }
  };

  const changed = (): void => {
    if (disposed) return;
    scheduleMain();
  };

  const publishOwner = (kind: OwnerEventV1['kind']): void => {
    if (disposed) return;
    safeEmit(OWNER_EVENT, Object.freeze({
      version: 1,
      ownerSessionId: options.ownerSessionId,
      ownerEpoch,
      generation: options.generation,
      kind,
    }));
  };

  const publishAttention = (attentionId: string, kind: AttentionEventV1['kind'], ambiguous: boolean): void => {
    if (disposed) return;
    safeEmit(ATTENTION_EVENT, Object.freeze({
      version: 1,
      ownerSessionId: options.ownerSessionId,
      ownerEpoch,
      attentionId,
      kind,
      ambiguous,
    }));
  };

  const rejectUnsupported = (resultChannel: string, value: unknown): void => {
    try {
      const parsed = parseEventRequest(value);
      if (!parsed.ok) {
        const identity = parsed.identity;
        if (!identity?.operation) return;
        const result = eventRequestResult({
          identity,
          operation: identity.operation,
          phase: 'rejected',
          sequence: 0,
          outcome: Object.freeze({ status: 'error', code: parsed.error, value: null }),
        });
        safeEmit(resultChannel, frozenResult(result));
        return;
      }
      const result = eventRequestResult({
        identity: parsed.value,
        operation: parsed.value.operation,
        phase: 'rejected',
        sequence: 0,
        outcome: Object.freeze({ status: 'error', code: 'UNSUPPORTED_API', value: null }),
      });
      safeEmit(resultChannel, frozenResult(result));
    } catch {
      // Invalid or hostile traffic is ignored. It never reaches Pi's logger.
    }
  };

  const frozenResult = (result: EventRequestResultV1): EventRequestResultV1 => {
    const copy = JSON.parse(JSON.stringify(result)) as EventRequestResultV1;
    return Object.freeze({
      version: copy.version,
      clientId: copy.clientId,
      requestId: copy.requestId,
      ownerSessionId: copy.ownerSessionId,
      ownerEpoch: copy.ownerEpoch,
      operation: copy.operation,
      phase: copy.phase,
      sequence: copy.sequence,
      outcome: Object.freeze({
        status: copy.outcome.status,
        code: copy.outcome.code,
        value: copy.outcome.value,
      }),
    });
  };

  const stopConversation = options.bus.on(CONVERSATION_REQUEST_EVENT, value => {
    rejectUnsupported(CONVERSATION_RESULT_EVENT, value);
  });
  const stopAttentionReply = options.bus.on(ATTENTION_REPLY_EVENT, value => {
    rejectUnsupported(ATTENTION_RESULT_EVENT, value);
  });
  const stopPing = options.bus.on(MAIN_PING_EVENT, () => {
    changed();
  });

  const capabilities = integrationsCapabilities(ownerEpoch, {
    content: options.contentEnabled,
    control: options.controlEnabled,
  });
  if (!capabilities) throw new Error('OptChat could not create owner capabilities.');

  return {
    ownerEpoch,
    generation: options.generation,
    capabilities,
    currentTurnId() { return turnId; },
    ready() {
      if (disposed || readyPublished) return;
      readyPublished = true;
      publishOwner('ready');
      publishMain();
    },
    replay() {
      if (disposed) return;
      publishOwner('replayed-ready');
      changed();
    },
    dispose(announce = true) {
      if (disposed) return;
      if (announce && readyPublished) {
        closing = true;
        turnId = null;
        activityPhase = 'idle';
        publishOwner('closing');
        publishMain();
      }
      disposed = true;
      cancelTimer();
      try { stopConversation(); } catch { /* best effort */ }
      try { stopAttentionReply(); } catch { /* best effort */ }
      try { stopPing(); } catch { /* best effort */ }
      openAttention.length = 0;
      attentionAmbiguous = false;
      tools.clear();
    },
    beginActivity() {
      if (disposed || closing) return;
      if (!turnId) turnId = generatedId();
      activityPhase = 'working';
      changed();
    },
    observeAssistantText() {
      if (disposed || closing) return;
      if (!turnId) turnId = generatedId();
      activityPhase = 'responding';
      changed();
    },
    settle() {
      if (disposed || closing) return;
      activityPhase = 'idle';
      turnId = null;
      tools.clear();
      toolCountUnknown = false;
      changed();
    },
    setPending(value) {
      if (disposed || closing || pending === value) return;
      pending = value;
      changed();
    },
    toolStarted(callId, toolName) {
      if (disposed || closing || !isIdentifier(callId)) return;
      const name = TOOL_NAME.test(toolName) ? toolName : null;
      tools.delete(callId);
      tools.set(callId, { name, order: ++toolOrder });
      if (tools.size > MAX_OBSERVED_TOOLS) {
        toolCountUnknown = true;
        const oldest = tools.keys().next().value as string | undefined;
        if (oldest !== undefined) tools.delete(oldest);
      }
      changed();
    },
    toolEnded(callId) {
      if (disposed || closing) return;
      if (tools.delete(callId)) changed();
    },
    attentionStarted() {
      if (disposed || closing) return;
      const attentionId = generatedId();
      if (attentionAmbiguous || openAttention.length >= MAX_OPEN_ATTENTION) {
        attentionAmbiguous = true;
        openAttention.length = 0;
        publishAttention(attentionId, 'started', true);
      } else {
        openAttention.push(attentionId);
        publishAttention(attentionId, 'started', false);
      }
      changed();
    },
    attentionEnded() {
      if (disposed || closing) return;
      if (attentionAmbiguous || openAttention.length === 0) {
        publishAttention(generatedId(), 'ended', true);
      } else {
        publishAttention(openAttention.pop()!, 'ended', false);
      }
      changed();
    },
  };
}
