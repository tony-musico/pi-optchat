/**
 * Bounded idempotency and operation lifecycle for OptChat event requests.
 *
 * The tracker owns admission, replay, conflict detection, deadlines, and
 * terminal-result publication. It does not know how an operation is performed:
 * an injected dispatcher receives only a validated, allowlisted request.
 */
import { createHash } from 'node:crypto';
import {
  EVENT_ERROR_CODES,
  EVENT_LIMITS,
  canonicalEventRequest,
  eventRequestResult,
  isSupportedOperation,
  parseEventRequest,
  resultChannel,
  type EventErrorCode,
  type EventOperation,
  type EventRequestIdentityV1,
  type EventRequestOutcomeV1,
  type EventRequestResultV1,
  type EventRequestV1,
  type JsonValueV1,
} from './events-contract.ts';

export interface RequestClock {
  now(): number;
}

export interface RequestTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface RequestBus {
  emit(channel: string, data: unknown): void;
}

export type EventDispatchResult =
  | { readonly ok: true; readonly value: JsonValueV1 }
  | { readonly ok: false; readonly code: EventErrorCode };

export interface EventDispatchContext {
  /**
   * Aborted on owner disposal, never on the operation deadline. A deadline is
   * an uncertainty boundary, not permission to cancel a mutation.
   */
  readonly signal: AbortSignal;
}

export type EventDispatcher = (
  request: EventRequestV1,
  context: EventDispatchContext,
) => EventDispatchResult | Promise<EventDispatchResult>;

export interface RequestTrackerOptions {
  readonly ownerEpoch: string;
  readonly ownerSessionId: string;
  readonly bus: RequestBus;
  readonly dispatch: EventDispatcher;
  readonly contentEnabled?: boolean;
  readonly controlEnabled?: boolean;
  readonly now?: () => number;
  readonly timer?: RequestTimer;
  /** Selects the result channel. Supply a custom adapter for a family-specific envelope. */
  readonly resultChannel?: (operation: EventOperation) => string | undefined;
  /** Mutations retain their admission slot after an uncertain deadline. */
  readonly isMutation?: (operation: EventOperation) => boolean;
  /** Synchronous operation-specific validation before acceptance and dispatch. */
  readonly validate?: (request: EventRequestV1) => EventErrorCode | undefined;
}

export interface RequestTracker {
  /** The owner epoch this tracker may accept. */
  readonly ownerEpoch: string;
  /** Bounded, non-sensitive retention counters for diagnostics and tests. */
  stats(): { readonly records: number; readonly retainedBytes: number; readonly inFlight: number };
  /**
   * Handles one untrusted request value. Malformed, unroutable traffic is
   * ignored. A routed request returns its current accepted or terminal result.
   */
  handle(value: unknown): EventRequestResultV1 | undefined;
  /** Ends accepted work, blocks late completions, and clears retained state. */
  dispose(): void;
}

interface RequestRecord {
  readonly key: string;
  readonly fingerprint: string;
  readonly canonicalBytes: number;
  readonly operation: EventOperation;
  readonly identity: EventRequestIdentityV1;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly deadlineAt: number;
  readonly mutation: boolean;
  resultJson: string;
  terminalPublished: boolean;
  uncertain: boolean;
  inFlight: boolean;
  slotReleased: boolean;
  reservedBytes: number;
  readonly controller: AbortController;
}

const defaultTimer: RequestTimer = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
  },
};

const TERMINAL_RESULT_RESERVE_BYTES = 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** Clone untrusted dispatch data into a bounded JSON value without invoking accessors. */
function cloneJsonValue(value: unknown, depth = 0, nodes = { count: 0 }): JsonValueV1 | undefined {
  try {
    if (++nodes.count > 100_000 || depth > 64) return undefined;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (Array.isArray(value)) {
      const copy: JsonValueV1[] = [];
      for (const item of value) {
        const cloned = cloneJsonValue(item, depth + 1, nodes);
        if (cloned === undefined) return undefined;
        copy.push(cloned);
      }
      return Object.freeze(copy);
    }
    if (!isPlainRecord(value)) return undefined;
    const copy = Object.create(null) as Record<string, JsonValueV1>;
    for (const key of Object.keys(value)) {
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
      catch { return undefined; }
      if (!descriptor || !('value' in descriptor)) return undefined;
      const cloned = cloneJsonValue(descriptor.value, depth + 1, nodes);
      if (cloned === undefined) return undefined;
      Object.defineProperty(copy, key, { value: cloned, enumerable: true, writable: false, configurable: false });
    }
    return Object.freeze(copy);
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function resultBytes(result: EventRequestResultV1): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

function errorOutcome(code: EventErrorCode): EventRequestOutcomeV1 {
  return Object.freeze({ status: 'error', code, value: null });
}

function okOutcome(value: JsonValueV1 | null = null): EventRequestOutcomeV1 {
  return Object.freeze({ status: 'ok', code: null, value });
}

function requestKey(request: EventRequestV1): string {
  return `${request.ownerEpoch}\u0000${request.clientId}\u0000${request.requestId}`;
}

function defaultMutation(operation: EventOperation): boolean {
  return operation === 'agent:spawn'
    || operation === 'agent:steer'
    || operation === 'agent:stop'
    || operation === 'agent:resume';
}

function operationNeedsContent(operation: EventOperation): boolean {
  return operation.startsWith('output:') || operation.startsWith('history:');
}

function operationNeedsControl(operation: EventOperation): boolean {
  return operation.startsWith('agent:');
}

/**
 * Creates a bounded request tracker. No real timer or network is used unless
 * the caller supplies one; tests can inject a manual clock and timer.
 */
export function createRequestTracker(options: RequestTrackerOptions): RequestTracker {
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? defaultTimer;
  const channelFor = options.resultChannel ?? resultChannel;
  const mutationFor = options.isMutation ?? defaultMutation;
  const records = new Map<string, RequestRecord>();
  let retainedBytes = 0;
  let inFlight = 0;
  let timerHandle: unknown;
  let timerDue: number | undefined;
  let disposed = false;

  const publish = (result: EventRequestResultV1): void => {
    const channel = channelFor(result.operation);
    if (!channel) return;
    try {
      // A fresh copy is published every time. Even a hostile subscriber that
      // ignores Object.freeze cannot mutate the retained dedupe state.
      const copy = deepFreeze(JSON.parse(JSON.stringify(result)) as EventRequestResultV1);
      options.bus.emit(channel, copy);
    } catch {
      // Bus and subscriber failures are deliberately silent. They never carry
      // exception text or request data into Pi's logger.
    }
  };

  const releaseSlot = (record: RequestRecord): void => {
    if (record.slotReleased) return;
    record.slotReleased = true;
    record.inFlight = false;
    if (inFlight > 0) inFlight--;
    retainedBytes -= record.reservedBytes;
    record.reservedBytes = 0;
  };

  const setRecordResult = (record: RequestRecord, result: EventRequestResultV1): void => {
    const next = JSON.stringify(result);
    retainedBytes += Buffer.byteLength(next, 'utf8') - Buffer.byteLength(record.resultJson, 'utf8');
    record.resultJson = next;
  };

  const removeRecord = (record: RequestRecord): void => {
    if (records.get(record.key) !== record) return;
    retainedBytes -= Buffer.byteLength(record.resultJson, 'utf8') + Buffer.byteLength(record.fingerprint, 'utf8');
    records.delete(record.key);
  };

  const purgeExpired = (at: number): void => {
    for (const record of [...records.values()]) {
      if (record.expiresAt > at) continue;
      // A timed-out mutation keeps its uncertainty guard and admission slot
      // until the underlying operation actually settles.
      if (record.inFlight && record.mutation) continue;
      releaseSlot(record);
      removeRecord(record);
    }
  };

  const earliestDue = (): number | undefined => {
    let due: number | undefined;
    for (const record of records.values()) {
      if (!record.terminalPublished) due = due === undefined ? record.deadlineAt : Math.min(due, record.deadlineAt);
      // An expired unsettled mutation has no timer work left. It is retained
      // until settlement, not rescheduled at every retry-window sweep.
      if (record.terminalPublished && record.inFlight && record.mutation) continue;
      due = due === undefined ? record.expiresAt : Math.min(due, record.expiresAt);
    }
    return due;
  };

  const cancelTimer = (): void => {
    if (timerHandle !== undefined) {
      try { timer.clear(timerHandle); } catch { /* a broken timer must not stop cleanup */ }
      timerHandle = undefined;
      timerDue = undefined;
    }
  };

  const schedule = (): void => {
    if (disposed) return;
    const due = earliestDue();
    if (due === undefined) { cancelTimer(); return; }
    const at = now();
    if (timerHandle !== undefined && timerDue !== undefined && timerDue <= due) return;
    cancelTimer();
    timerDue = due;
    try {
      timerHandle = timer.set(() => {
        timerHandle = undefined;
        timerDue = undefined;
        if (disposed) return;
        const current = now();
        purgeExpired(current);
        for (const record of [...records.values()]) {
          if (record.terminalPublished || current < record.deadlineAt) continue;
          const result = eventRequestResult({
            identity: record.identity,
            operation: record.operation,
            phase: 'completed',
            sequence: 2,
            outcome: errorOutcome('OUTCOME_UNKNOWN'),
          });
          setRecordResult(record, result);
          record.terminalPublished = true;
          record.uncertain = record.mutation;
          publish(result);
          // A mutation keeps its slot until the underlying method settles.
          if (!record.mutation) releaseSlot(record);
        }
        schedule();
      }, Math.max(0, due - at));
    } catch {
      timerHandle = undefined;
      timerDue = undefined;
    }
  };

  const rejected = (identity: EventRequestIdentityV1, operation: EventOperation, code: EventErrorCode): EventRequestResultV1 => {
    const result = eventRequestResult({
      identity,
      operation,
      phase: 'rejected',
      sequence: 0,
      outcome: errorOutcome(code),
    });
    publish(result);
    return result;
  };

  const handleParsed = (request: EventRequestV1): EventRequestResultV1 => {
    if (disposed) return rejected(request, request.operation, 'OWNER_CLOSING');
    if (request.ownerEpoch !== options.ownerEpoch || request.ownerSessionId !== options.ownerSessionId) {
      return rejected(request, request.operation, 'STALE_OWNER');
    }
    if (!isSupportedOperation(request.operation)) {
      return rejected(request, request.operation, 'UNSUPPORTED_API');
    }
    if (operationNeedsContent(request.operation) && options.contentEnabled !== true) {
      return rejected(request, request.operation, 'DISABLED');
    }
    if (operationNeedsControl(request.operation) && options.controlEnabled !== true) {
      return rejected(request, request.operation, 'DISABLED');
    }

    const canonical = canonicalEventRequest(request);
    const canonicalBytes = Buffer.byteLength(canonical, 'utf8');
    if (canonicalBytes > EVENT_LIMITS.executableStringBytes) {
      return rejected(request, request.operation, 'CAPACITY');
    }
    const fingerprint = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const key = requestKey(request);

    const existing = records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return rejected(request, request.operation, 'REQUEST_CONFLICT');
      const replay = JSON.parse(existing.resultJson) as EventRequestResultV1;
      publish(replay);
      return deepFreeze(replay);
    }

    // An uncertain mutation may not be bypassed with a new request id.
    if (mutationFor(request.operation)) {
      for (const record of records.values()) {
        if (record.uncertain && record.fingerprint === fingerprint) {
          return rejected(request, request.operation, 'OUTCOME_UNKNOWN');
        }
      }
    }

    let validationError: EventErrorCode | undefined;
    try { validationError = options.validate?.(request); }
    catch { validationError = 'INTERNAL_ERROR'; }
    if (validationError) return rejected(request, request.operation, validationError);

    const identity: EventRequestIdentityV1 = {
      clientId: request.clientId,
      requestId: request.requestId,
      ownerSessionId: request.ownerSessionId,
      ownerEpoch: request.ownerEpoch,
      operation: request.operation,
    };
    const accepted = eventRequestResult({
      identity,
      operation: request.operation,
      phase: 'accepted',
      sequence: 1,
      outcome: okOutcome(),
    });
    const acceptedJson = JSON.stringify(accepted);

    purgeExpired(now());
    if (records.size >= EVENT_LIMITS.idempotencyRecords) {
      return rejected(request, request.operation, 'CAPACITY');
    }
    if (inFlight >= EVENT_LIMITS.inFlightRequests) {
      return rejected(request, request.operation, 'CAPACITY');
    }
    const projectedBytes = retainedBytes
      + Buffer.byteLength(acceptedJson, 'utf8')
      + Buffer.byteLength(fingerprint, 'utf8')
      + TERMINAL_RESULT_RESERVE_BYTES;
    if (projectedBytes > EVENT_LIMITS.retainedResultBytes) {
      return rejected(request, request.operation, 'CAPACITY');
    }

    const createdAt = now();
    const record: RequestRecord = {
      key,
      fingerprint,
      canonicalBytes,
      operation: request.operation,
      identity,
      createdAt,
      expiresAt: createdAt + EVENT_LIMITS.retryWindowMs,
      deadlineAt: createdAt + EVENT_LIMITS.operationDeadlineMs,
      mutation: mutationFor(request.operation),
      resultJson: acceptedJson,
      terminalPublished: false,
      uncertain: false,
      inFlight: true,
      slotReleased: false,
      reservedBytes: TERMINAL_RESULT_RESERVE_BYTES,
      controller: new AbortController(),
    };
    records.set(key, record);
    retainedBytes += Buffer.byteLength(acceptedJson, 'utf8') + Buffer.byteLength(fingerprint, 'utf8');
    retainedBytes += record.reservedBytes;
    inFlight++;
    publish(accepted);

    if (disposed) {
      if (!record.terminalPublished) {
        const closing = eventRequestResult({
          identity,
          operation: request.operation,
          phase: 'completed',
          sequence: 2,
          outcome: errorOutcome('OWNER_CLOSING'),
        });
        setRecordResult(record, closing);
        record.terminalPublished = true;
        publish(closing);
        releaseSlot(record);
      }
      return deepFreeze(JSON.parse(record.resultJson) as EventRequestResultV1);
    }

    let dispatched: EventDispatchResult | Promise<EventDispatchResult>;
    try {
      dispatched = options.dispatch(request, { signal: record.controller.signal });
    } catch {
      dispatched = { ok: false, code: 'INTERNAL_ERROR' };
    }
    try {
      void Promise.resolve(dispatched).then(
        value => settle(record, value),
        () => settle(record, { ok: false, code: 'INTERNAL_ERROR' }),
      );
    } catch {
      settle(record, { ok: false, code: 'INTERNAL_ERROR' });
    }
    schedule();
    return deepFreeze(JSON.parse(record.resultJson) as EventRequestResultV1);
  };

  const finishRecord = (record: RequestRecord): void => {
    releaseSlot(record);
    if (!disposed && record.expiresAt <= now() && records.get(record.key) === record) removeRecord(record);
  };

  const settleInternal = (record: RequestRecord, dispatched: EventDispatchResult): void => {
    if (disposed || record.terminalPublished) {
      finishRecord(record);
      return;
    }
    let outcome: EventRequestOutcomeV1;
    if (dispatched?.ok === true) {
      const value = cloneJsonValue(dispatched.value);
      if (value === undefined) outcome = errorOutcome('INTERNAL_ERROR');
      else outcome = okOutcome(value);
    } else if (dispatched?.ok === false) {
      const code = EVENT_ERROR_CODES.includes(dispatched.code) ? dispatched.code : 'INTERNAL_ERROR';
      outcome = errorOutcome(code);
    } else {
      outcome = errorOutcome('INTERNAL_ERROR');
    }
    const result = eventRequestResult({
      identity: record.identity,
      operation: record.operation,
      phase: 'completed',
      sequence: 2,
      outcome,
    });
    const nextBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    const oldBytes = Buffer.byteLength(record.resultJson, 'utf8');
    const reserved = record.reservedBytes;
    const projected = retainedBytes - oldBytes - reserved + nextBytes;
    if (projected > EVENT_LIMITS.retainedResultBytes) {
      const capacity = eventRequestResult({
        identity: record.identity,
        operation: record.operation,
        phase: 'completed',
        sequence: 2,
        outcome: errorOutcome('CAPACITY'),
      });
      setRecordResult(record, capacity);
      record.terminalPublished = true;
      publish(capacity);
    } else {
      setRecordResult(record, result);
      record.terminalPublished = true;
      publish(result);
    }
    finishRecord(record);
    schedule();
  };

  const settle = (record: RequestRecord, dispatched: EventDispatchResult): void => {
    try {
      settleInternal(record, dispatched);
    } catch {
      // A broken adapter or hostile value must not escape into Pi's logger.
      if (!disposed && !record.terminalPublished) {
        try {
          const internal = eventRequestResult({
            identity: record.identity,
            operation: record.operation,
            phase: 'completed',
            sequence: 2,
            outcome: errorOutcome('INTERNAL_ERROR'),
          });
          setRecordResult(record, internal);
          record.terminalPublished = true;
          publish(internal);
        } catch { /* the fixed fallback itself is best effort */ }
      }
      finishRecord(record);
    }
  };

  const tracker: RequestTracker = {
    ownerEpoch: options.ownerEpoch,
    stats() { return { records: records.size, retainedBytes, inFlight }; },
    handle(value) {
      try {
        const parsed = parseEventRequest(value);
        if (!parsed.ok) {
          const identity = parsed.identity;
          if (!identity?.operation) return undefined;
          const operation = identity.operation;
          const result = eventRequestResult({
            identity,
            operation,
            phase: 'rejected',
            sequence: 0,
            outcome: errorOutcome(parsed.error),
          });
          publish(result);
          return deepFreeze(result);
        }
        return handleParsed(parsed.value);
      } catch {
        // The public event handler must never let an arbitrary exception reach
        // Pi's logger. Malformed traffic is simply ignored.
        return undefined;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      for (const record of records.values()) {
        if (!record.terminalPublished) {
          const closing = eventRequestResult({
            identity: record.identity,
            operation: record.operation,
            phase: 'completed',
            sequence: 2,
            outcome: errorOutcome('OWNER_CLOSING'),
          });
          record.resultJson = JSON.stringify(closing);
          record.terminalPublished = true;
          publish(closing);
        }
        try { record.controller.abort(); } catch { /* aborting is best effort */ }
        releaseSlot(record);
      }
      records.clear();
      retainedBytes = 0;
      inFlight = 0;
    },
  };

  return tracker;
}

/**
 * A listener wrapper for Pi's event bus. It catches every failure inside the
 * extension so Pi never logs an arbitrary exception or request payload.
 */
export function requestListener(tracker: RequestTracker): (value: unknown) => void {
  return value => {
    try { tracker.handle(value); }
    catch { /* intentionally fixed and silent */ }
  };
}
