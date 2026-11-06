import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_LIMITS, type EventRequestResultV1 } from '../src/events-contract.ts';
import {
  createRequestTracker,
  requestListener,
  type EventDispatchResult,
  type RequestTimer,
} from '../src/events-requests.ts';

function clock() {
  let current = 1_000;
  let next = 1;
  const tasks = new Map<number, { at: number; run: () => void }>();
  const timer: RequestTimer = {
    set(run, delayMs) {
      const id = next++;
      tasks.set(id, { at: current + delayMs, run });
      return id;
    },
    clear(handle) { tasks.delete(handle as number); },
  };
  return {
    now: () => current,
    timer,
    advance(ms: number) {
      const until = current + ms;
      for (;;) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= until).sort((a, b) => a[0] - b[0])[0];
        if (!due) break;
        current = due[1].at;
        tasks.delete(due[0]);
        due[1].run();
      }
      current = until;
    },
    pending: () => tasks.size,
  };
}

function bus(onEmit?: (channel: string, data: EventRequestResultV1) => void) {
  const emitted: { channel: string; data: EventRequestResultV1 }[] = [];
  return {
    emitted,
    api: {
      emit(channel: string, data: unknown) {
        const result = data as EventRequestResultV1;
        emitted.push({ channel, data: result });
        onEmit?.(channel, result);
      },
    },
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  clientId: 'client-1',
  requestId: 'request-1',
  ownerSessionId: 'session-1',
  ownerEpoch: 'epoch-1',
  operation: 'agent:stop',
  payload: { runId: 'run-1', expectedStartedAt: 1 },
  ...overrides,
});

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test('an accepted request is published before dispatch and can be replayed without a second dispatch', async () => {
  const time = clock();
  const events = bus();
  let dispatchCount = 0;
  let resolveDispatch!: (value: EventDispatchResult) => void;
  const pending = new Promise<EventDispatchResult>(resolve => { resolveDispatch = resolve; });
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1',
    ownerSessionId: 'session-1',
    bus: events.api,
    controlEnabled: true,
    now: time.now,
    timer: time.timer,
    resultChannel: () => 'test:result',
    dispatch: () => { dispatchCount++; return pending; },
  });

  const first = tracker.handle(request());
  assert.ok(first);
  assert.equal(first.phase, 'accepted');
  assert.equal(first.sequence, 1);
  assert.equal(dispatchCount, 1);
  assert.deepEqual(events.emitted.map(event => event.data.phase), ['accepted']);

  const replay = tracker.handle(request());
  assert.ok(replay);
  assert.equal(replay.phase, 'accepted');
  assert.equal(replay.sequence, 1);
  assert.equal(dispatchCount, 1);
  assert.deepEqual(events.emitted.map(event => event.data.phase), ['accepted', 'accepted']);

  resolveDispatch({ ok: true, value: { stopped: true } });
  await settled();
  const terminal = tracker.handle(request());
  assert.ok(terminal);
  assert.equal(terminal.phase, 'completed');
  assert.equal(terminal.sequence, 2);
  assert.equal(terminal.outcome.status, 'ok');
  assert.deepEqual(terminal.outcome.value, { stopped: true });
  assert.equal(dispatchCount, 1);
  assert.deepEqual(events.emitted.map(event => event.data.phase), ['accepted', 'accepted', 'completed', 'completed']);
  tracker.dispose();
});

test('a hostile subscriber cannot mutate the retained dedupe result', async () => {
  const time = clock();
  const events = bus((_channel, data) => {
    try { (data as unknown as { clientId: string }).clientId = 'hijacked'; }
    catch { /* frozen publication rejects the mutation */ }
  });
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => ({ ok: true, value: { runId: 'run-1' } }),
  });
  tracker.handle(request());
  await settled();
  const replay = tracker.handle(request());
  assert.ok(replay);
  assert.equal(replay.clientId, 'client-1');
  assert.deepEqual(replay.outcome.value, { runId: 'run-1' });
  tracker.dispose();
});

test('the same id with a changed operation or payload is a conflict, never a replay', async () => {
  const time = clock();
  const events = bus();
  let dispatchCount = 0;
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => { dispatchCount++; return { ok: true, value: null }; },
  });
  const accepted = tracker.handle(request());
  assert.equal(accepted?.phase, 'accepted');
  await settled();

  const changedOperation = tracker.handle(request({ operation: 'agent:resume', payload: { runId: 'run-1', expectedStartedAt: 1, message: 'resume' } }));
  assert.equal(changedOperation?.phase, 'rejected');
  assert.equal(changedOperation?.outcome.code, 'REQUEST_CONFLICT');
  const changedPayload = tracker.handle(request({ payload: { runId: 'run-1', expectedStartedAt: 2 } }));
  assert.equal(changedPayload?.phase, 'rejected');
  assert.equal(changedPayload?.outcome.code, 'REQUEST_CONFLICT');
  assert.equal(dispatchCount, 1);
  tracker.dispose();
});

test('the idempotency cache rejects count saturation instead of evicting live records', async () => {
  const time = clock();
  const events = bus();
  let dispatchCount = 0;
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => { dispatchCount++; return { ok: true, value: null }; },
  });
  for (let index = 0; index < EVENT_LIMITS.idempotencyRecords; index++) {
    const result = tracker.handle(request({ requestId: `request-${index}` }));
    assert.equal(result?.phase, 'accepted');
    await settled();
  }
  const overflow = tracker.handle(request({ requestId: 'request-overflow' }));
  assert.equal(overflow?.phase, 'rejected');
  assert.equal(overflow?.outcome.code, 'CAPACITY');
  assert.equal(dispatchCount, EVENT_LIMITS.idempotencyRecords);
  tracker.dispose();
});

test('retained result bytes are bounded and byte saturation rejects new work', async () => {
  const time = clock();
  const events = bus();
  let dispatchCount = 0;
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => { dispatchCount++; return { ok: true, value: 'x'.repeat(1_048_058) }; },
  });
  for (let index = 0; index < 4; index++) {
    const result = tracker.handle(request({ requestId: `request-${index}` }));
    assert.equal(result?.phase, 'accepted');
    await settled();
  }
  const overflow = tracker.handle(request({ requestId: 'request-overflow' }));
  assert.equal(overflow?.phase, 'rejected', JSON.stringify(tracker.stats()));
  assert.equal(overflow?.outcome.code, 'CAPACITY');
  assert.equal(dispatchCount, 4);
  tracker.dispose();
});

test('in-flight admission is capped at sixteen accepted requests', () => {
  const time = clock();
  const events = bus();
  let dispatchCount = 0;
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => { dispatchCount++; return new Promise<EventDispatchResult>(() => {}); },
  });
  for (let index = 0; index < EVENT_LIMITS.inFlightRequests; index++) {
    const result = tracker.handle(request({ requestId: `request-${index}` }));
    assert.equal(result?.phase, 'accepted');
  }
  const overflow = tracker.handle(request({ requestId: 'request-overflow' }));
  assert.equal(overflow?.phase, 'rejected');
  assert.equal(overflow?.outcome.code, 'CAPACITY');
  assert.equal(dispatchCount, EVENT_LIMITS.inFlightRequests);
  tracker.dispose();
});

test('records expire after the retry window and may then be admitted again', async () => {
  const time = clock();
  const events = bus();
  let dispatchCount = 0;
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => { dispatchCount++; return { ok: true, value: null }; },
  });
  assert.equal(tracker.handle(request())?.phase, 'accepted');
  await settled();
  time.advance(EVENT_LIMITS.retryWindowMs + 1);
  assert.equal(tracker.handle(request())?.phase, 'accepted');
  assert.equal(dispatchCount, 2);
  tracker.dispose();
});

test('a deadline makes an already-dispatched mutation unknown without cancelling or redispatching it', async () => {
  const time = clock();
  const events = bus();
  let dispatchCount = 0;
  let resolveDispatch!: (value: EventDispatchResult) => void;
  let signal!: AbortSignal;
  const pending = new Promise<EventDispatchResult>(resolve => { resolveDispatch = resolve; });
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: (_request, context) => { dispatchCount++; signal = context.signal; return pending; },
  });
  tracker.handle(request());
  time.advance(EVENT_LIMITS.operationDeadlineMs);
  const unknown = events.emitted.find(event => event.data.phase === 'completed');
  assert.ok(unknown);
  assert.equal(unknown.data.outcome.code, 'OUTCOME_UNKNOWN');
  assert.equal(unknown.data.sequence, 2);
  assert.equal(signal.aborted, false);
  assert.equal(dispatchCount, 1);
  assert.equal(events.emitted.filter(event => event.data.phase === 'completed').length, 1);

  const replay = tracker.handle(request());
  assert.equal(replay?.outcome.code, 'OUTCOME_UNKNOWN');
  const newId = tracker.handle(request({ requestId: 'request-2' }));
  assert.equal(newId?.phase, 'rejected');
  assert.equal(newId?.outcome.code, 'OUTCOME_UNKNOWN');
  assert.equal(dispatchCount, 1);

  resolveDispatch({ ok: true, value: { stopped: true } });
  await settled();
  assert.equal(events.emitted.filter(event => event.data.phase === 'completed').length, 2, 'only the explicit replay and the original timeout are present');
  assert.equal(dispatchCount, 1);
  tracker.dispose();
});

test('an unsettled timed-out mutation keeps its slot and uncertainty guard beyond the retry window', async () => {
  const time = clock();
  const events = bus();
  let dispatchCount = 0;
  let resolveFirst!: (value: EventDispatchResult) => void;
  const firstPending = new Promise<EventDispatchResult>(resolve => { resolveFirst = resolve; });
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => {
      dispatchCount += 1;
      return dispatchCount === 1 ? firstPending : Promise.resolve({ ok: true, value: { stopped: true } });
    },
  });

  tracker.handle(request());
  time.advance(EVENT_LIMITS.operationDeadlineMs);
  const unknown = events.emitted.find(event => event.data.phase === 'completed');
  assert.equal(unknown?.data.outcome.code, 'OUTCOME_UNKNOWN');
  const retained = tracker.stats();
  assert.equal(retained.inFlight, 1);
  assert.equal(retained.records, 1);
  assert.ok(retained.retainedBytes > 0);
  assert.equal(time.pending(), 0, 'the settled timeout does not keep rescheduling the expired record');

  time.advance(EVENT_LIMITS.retryWindowMs + 1);
  assert.deepEqual(tracker.stats(), retained, 'the expired unsettled mutation still owns its slot and bytes');
  const sameId = tracker.handle(request());
  assert.equal(sameId?.outcome.code, 'OUTCOME_UNKNOWN');
  const newId = tracker.handle(request({ requestId: 'request-new-id' }));
  assert.equal(newId?.phase, 'rejected');
  assert.equal(newId?.outcome.code, 'OUTCOME_UNKNOWN');
  assert.equal(dispatchCount, 1);

  resolveFirst({ ok: true, value: { stopped: true } });
  await settled();
  assert.deepEqual(tracker.stats(), { records: 0, retainedBytes: 0, inFlight: 0 });
  const admitted = tracker.handle(request({ requestId: 'request-after-settlement' }));
  assert.equal(admitted?.phase, 'accepted');
  assert.equal(dispatchCount, 2);
  tracker.dispose();
});

test('a late rejection after the deadline cannot publish a second terminal result', async () => {
  const time = clock();
  const events = bus();
  let rejectDispatch!: (error: Error) => void;
  const pending = new Promise<EventDispatchResult>((_resolve, reject) => { rejectDispatch = reject; });
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => pending,
  });
  tracker.handle(request());
  time.advance(EVENT_LIMITS.operationDeadlineMs);
  rejectDispatch(new Error('SECRET-LATE-ERROR'));
  await settled();
  assert.equal(events.emitted.filter(event => event.data.phase === 'completed').length, 1);
  assert.doesNotMatch(JSON.stringify(events.emitted), /SECRET-LATE-ERROR/);
  tracker.dispose();
});

test('a synchronous callback failure and a rejected promise become fixed internal errors', async () => {
  const time = clock();
  const events = bus();
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => { throw new Error('SECRET-CALLBACK-ERROR'); },
  });
  tracker.handle(request());
  await settled();
  const terminal = events.emitted.find(event => event.data.phase === 'completed');
  assert.ok(terminal);
  assert.equal(terminal.data.outcome.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(events.emitted), /SECRET-CALLBACK-ERROR/);
  tracker.dispose();

  const secondEvents = bus();
  const second = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: secondEvents.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => Promise.reject(new Error('SECRET-PROMISE-ERROR')),
  });
  second.handle(request());
  await settled();
  const secondTerminal = secondEvents.emitted.find(event => event.data.phase === 'completed');
  assert.equal(secondTerminal?.data.outcome.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(secondEvents.emitted), /SECRET-PROMISE-ERROR/);
  second.dispose();
});

test('dispose ends accepted work, aborts its adapter, clears state, and blocks late settlement', async () => {
  const time = clock();
  const events = bus();
  let resolveDispatch!: (value: EventDispatchResult) => void;
  let signal!: AbortSignal;
  const pending = new Promise<EventDispatchResult>(resolve => { resolveDispatch = resolve; });
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: (_request, context) => { signal = context.signal; return pending; },
  });
  tracker.handle(request());
  tracker.dispose();
  assert.equal(signal.aborted, true);
  const closing = events.emitted.find(event => event.data.phase === 'completed');
  assert.equal(closing?.data.outcome.code, 'OWNER_CLOSING');
  const afterDispose = tracker.handle(request());
  assert.equal(afterDispose?.phase, 'rejected');
  assert.equal(afterDispose?.outcome.code, 'OWNER_CLOSING');
  resolveDispatch({ ok: true, value: null });
  await settled();
  assert.equal(events.emitted.filter(event => event.data.phase === 'completed').length, 1);
});

test('a reentrant listener can dispose during acceptance before the adapter is called', () => {
  const time = clock();
  let tracker: ReturnType<typeof createRequestTracker>;
  let dispatchCount = 0;
  const events = bus((_channel, data) => {
    if (data.phase === 'accepted') tracker.dispose();
  });
  tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => { dispatchCount++; return { ok: true, value: null }; },
  });
  const result = tracker.handle(request());
  assert.equal(result?.phase, 'completed');
  assert.equal(result?.outcome.code, 'OWNER_CLOSING');
  assert.equal(dispatchCount, 0);
  assert.deepEqual(events.emitted.map(event => event.data.outcome.code), [null, 'OWNER_CLOSING']);
});

test('a replaced owner epoch rejects stale work and an old completion cannot publish into it', async () => {
  const time = clock();
  const events = bus();
  let resolveOld!: (value: EventDispatchResult) => void;
  const oldPending = new Promise<EventDispatchResult>(resolve => { resolveOld = resolve; });
  const old = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => oldPending,
  });
  old.handle(request());
  old.dispose();

  const replacement = createRequestTracker({
    ownerEpoch: 'epoch-2', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => ({ ok: true, value: null }),
  });
  const stale = replacement.handle(request());
  assert.equal(stale?.phase, 'rejected');
  assert.equal(stale?.outcome.code, 'STALE_OWNER');
  const current = replacement.handle(request({ ownerEpoch: 'epoch-2', requestId: 'request-2' }));
  assert.equal(current?.phase, 'accepted');
  const beforeOldTerminals = events.emitted.filter(event => event.data.ownerEpoch === 'epoch-1' && event.data.phase === 'completed').length;
  resolveOld({ ok: true, value: null });
  await settled();
  assert.equal(events.emitted.filter(event => event.data.ownerEpoch === 'epoch-1' && event.data.phase === 'completed').length, beforeOldTerminals);
  replacement.dispose();
});

test('unsupported and disabled families are rejected before dispatch', () => {
  const time = clock();
  const events = bus();
  let dispatchCount = 0;
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api,
    contentEnabled: false, controlEnabled: false,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => { dispatchCount++; return { ok: true, value: null }; },
  });
  const unsupported = tracker.handle(request({
    operation: 'conversation:submit',
    payload: { text: 'must never dispatch' },
  }));
  assert.equal(unsupported?.outcome.code, 'UNSUPPORTED_API');
  const content = tracker.handle(request({
    operation: 'history:recent',
    payload: { limit: 20, cursor: null },
  }));
  assert.equal(content?.outcome.code, 'DISABLED');
  const control = tracker.handle(request());
  assert.equal(control?.outcome.code, 'DISABLED');
  assert.equal(dispatchCount, 0);
  tracker.dispose();
});

test('the public listener wrapper never lets a tracker failure escape', () => {
  const time = clock();
  const events = bus();
  const tracker = createRequestTracker({
    ownerEpoch: 'epoch-1', ownerSessionId: 'session-1', bus: events.api, controlEnabled: true,
    now: time.now, timer: time.timer, resultChannel: () => 'test:result',
    dispatch: () => ({ ok: true, value: null }),
  });
  const listener = requestListener(tracker);
  assert.doesNotThrow(() => listener({ throwing: true }));
  assert.doesNotThrow(() => listener(request()));
  tracker.dispose();
});
