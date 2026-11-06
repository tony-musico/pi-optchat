import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatusPublisher, type StatusCapabilitiesV1 } from '../src/agent-status.ts';
import {
  ATTENTION_EVENT,
  ATTENTION_REPLY_EVENT,
  ATTENTION_RESULT_EVENT,
  CONVERSATION_REQUEST_EVENT,
  CONVERSATION_RESULT_EVENT,
  MAIN_PING_EVENT,
  MAIN_STATUS_EVENT,
  OWNER_EVENT,
  OUTPUT_SUBSCRIBE_EVENT,
  OUTPUT_UNSUBSCRIBE_EVENT,
  type AttentionEventV1,
  type EventRequestResultV1,
  type MainStatusV1,
  type OwnerEventV1,
} from '../src/events-contract.ts';
import { createOwnerEvents, type OwnerEventTimer } from '../src/owner-events.ts';
import { createOutputEvents } from '../src/output-events.ts';

function clock() {
  let current = 10_000;
  let next = 1;
  const tasks = new Map<number, { at: number; run: () => void }>();
  const timer: OwnerEventTimer = {
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

function bus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: { channel: string; data: unknown }[] = [];
  const order: string[] = [];
  return {
    emitted,
    order,
    api: {
      emit(channel: string, data: unknown) {
        order.push(`emit:${channel}`);
        emitted.push({ channel, data });
        for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        order.push(`on:${channel}`);
        const set = handlers.get(channel) ?? new Set();
        set.add(handler);
        handlers.set(channel, set);
        return () => { set.delete(handler); };
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
  operation: 'conversation:submit',
  payload: { text: 'must not dispatch' },
  ...overrides,
});

function owner(busApi: ReturnType<typeof bus>, time: ReturnType<typeof clock>, epoch = 'epoch-1') {
  return createOwnerEvents({
    bus: busApi.api,
    ownerSessionId: 'session-1',
    generation: 7,
    contentEnabled: false,
    controlEnabled: false,
    now: time.now,
    timer: time.timer,
    epochFactory: () => epoch,
    idFactory: (() => {
      let id = 0;
      return () => `generated-${++id}`;
    })(),
  });
}

test('request listeners exist before the first capability advertisement and capabilities stay additive', () => {
  const time = clock();
  const events = bus();
  const coordinator = owner(events, time);
  const output = createOutputEvents({
    bus: events.api,
    ownerSessionId: 'session-1',
    ownerEpoch: coordinator.ownerEpoch,
    contentEnabled: false,
    turnId: () => null,
    now: time.now,
    timer: time.timer,
  });
  const publisher = createStatusPublisher({
    bus: events.api,
    profile: 'work',
    ownerSessionId: 'session-1',
    integrations: coordinator.capabilities,
    source: { list: () => [], live: () => undefined },
  });
  coordinator.ready();

  const firstEmit = events.order.findIndex(entry => entry.startsWith('emit:'));
  const lastListener = events.order.slice(0, firstEmit).map(entry => entry.slice(3));
  assert.ok(lastListener.includes(CONVERSATION_REQUEST_EVENT));
  assert.ok(lastListener.includes(ATTENTION_REPLY_EVENT));
  assert.ok(lastListener.includes(MAIN_PING_EVENT));
  assert.ok(lastListener.includes(OUTPUT_SUBSCRIBE_EVENT));
  assert.ok(lastListener.includes(OUTPUT_UNSUBSCRIBE_EVENT));

  const capability = events.emitted.find(event => event.channel === 'optchat:capabilities:v1')?.data as StatusCapabilitiesV1;
  assert.ok(capability);
  assert.deepEqual(Object.keys(capability), ['version', 'profile', 'ownerSessionId', 'events', 'status', 'integrations']);
  assert.equal(capability.status.observationOnly, true);
  assert.equal(capability.integrations?.ownerEpoch, 'epoch-1');
  assert.equal(capability.integrations?.content.enabled, false);
  assert.equal(capability.integrations?.control.enabled, false);
  assert.deepEqual(capability.integrations?.unsupported.map(item => item.operation), [
    'conversation:submit', 'conversation:queue', 'conversation:steer', 'attention:reply',
  ]);
  publisher.dispose();
  output.dispose();
  coordinator.dispose();
});

test('same-owner replay keeps the epoch and listeners, while a new owner has a fresh epoch', () => {
  const time = clock();
  const events = bus();
  const coordinator = owner(events, time);
  coordinator.ready();
  const listeners = events.order.filter(entry => entry.startsWith('on:')).length;
  coordinator.replay();
  coordinator.replay();
  assert.equal(events.order.filter(entry => entry.startsWith('on:')).length, listeners);
  const owners = events.emitted.filter(event => event.channel === OWNER_EVENT).map(event => event.data as OwnerEventV1);
  assert.deepEqual(owners.map(event => event.kind), ['ready', 'replayed-ready', 'replayed-ready']);
  assert.ok(owners.every(event => event.ownerEpoch === 'epoch-1'));
  const second = owner(events, time, 'epoch-2');
  second.ready();
  assert.notEqual(second.ownerEpoch, coordinator.ownerEpoch);
  coordinator.dispose();
  second.dispose();
});

test('main phases use real precedence and a turn survives until settlement', () => {
  const time = clock();
  const events = bus();
  const coordinator = owner(events, time);
  coordinator.ready();
  coordinator.beginActivity();
  coordinator.beginActivity();
  time.advance(250);
  let status = events.emitted.filter(event => event.channel === MAIN_STATUS_EVENT).at(-1)?.data as MainStatusV1;
  assert.equal(status.phase, 'working');
  assert.ok(status.turnId);
  const turnId = status.turnId;

  coordinator.observeAssistantText();
  time.advance(250);
  status = events.emitted.filter(event => event.channel === MAIN_STATUS_EVENT).at(-1)?.data as MainStatusV1;
  assert.equal(status.phase, 'responding');
  assert.equal(status.turnId, turnId);

  coordinator.attentionStarted();
  time.advance(250);
  status = events.emitted.filter(event => event.channel === MAIN_STATUS_EVENT).at(-1)?.data as MainStatusV1;
  assert.equal(status.phase, 'awaiting-input');

  coordinator.dispose();
  status = events.emitted.filter(event => event.channel === MAIN_STATUS_EVENT).at(-1)?.data as MainStatusV1;
  assert.equal(status.phase, 'closing');
  assert.equal(status.turnId, null);
});

test('tool names are sanitized, counts are bounded, and arguments are never accepted', () => {
  const time = clock();
  const events = bus();
  const coordinator = owner(events, time);
  coordinator.ready();
  coordinator.toolStarted('call-1', 'read');
  coordinator.toolStarted('call-2', 'bash --rm -rf /');
  coordinator.toolStarted('call-3', 'write');
  time.advance(250);
  let status = events.emitted.filter(event => event.channel === MAIN_STATUS_EVENT).at(-1)?.data as MainStatusV1;
  assert.equal(status.currentTool, 'write');
  assert.equal(status.toolCount, 3);
  assert.doesNotMatch(JSON.stringify(status), /rm -rf|SECRET-TASK/);

  for (let index = 0; index < 40; index++) coordinator.toolStarted(`more-${index}`, 'tool');
  time.advance(250);
  status = events.emitted.filter(event => event.channel === MAIN_STATUS_EVENT).at(-1)?.data as MainStatusV1;
  assert.equal(status.toolCount, null, 'overflow is reported as unknown rather than fabricated');
  assert.equal(status.currentTool, 'tool');
  coordinator.dispose();
});

test('pending is a real boolean while queue depth remains unknown', () => {
  const time = clock();
  const events = bus();
  const coordinator = owner(events, time);
  coordinator.ready();
  coordinator.setPending(true);
  time.advance(250);
  const status = events.emitted.filter(event => event.channel === MAIN_STATUS_EVENT).at(-1)?.data as MainStatusV1;
  assert.equal(status.pending, true);
  assert.equal(status.queueDepth, null);
  assert.equal(status.exactQueueDepth, false);
  coordinator.dispose();
});

test('attention observations pair by bounded stack and never publish titles or answers', () => {
  const time = clock();
  const events = bus();
  const coordinator = owner(events, time);
  coordinator.ready();
  coordinator.attentionStarted();
  coordinator.attentionStarted();
  coordinator.attentionEnded();
  const attention = events.emitted.filter(event => event.channel === ATTENTION_EVENT).map(event => event.data as AttentionEventV1);
  assert.deepEqual(attention.map(event => event.kind), ['started', 'started', 'ended']);
  assert.equal(attention[2].attentionId, attention[1].attentionId);
  assert.equal(attention[2].ambiguous, false);
  assert.doesNotMatch(JSON.stringify(attention), /title|answer|options|SECRET-PROMPT/);

  for (let index = 0; index < 40; index++) coordinator.attentionStarted();
  coordinator.attentionEnded();
  const overflow = events.emitted.filter(event => event.channel === ATTENTION_EVENT).map(event => event.data as AttentionEventV1);
  assert.ok(overflow.some(event => event.ambiguous));
  coordinator.dispose();
});

test('conversation and attention-reply requests are fixed unsupported rejections with zero dispatch', () => {
  const time = clock();
  const events = bus();
  const coordinator = owner(events, time);
  coordinator.ready();
  events.api.emit(CONVERSATION_REQUEST_EVENT, request({ payload: { text: 'SECRET-PROMPT' } }));
  events.api.emit(ATTENTION_REPLY_EVENT, request({
    operation: 'attention:reply',
    payload: { attentionId: 'attention-1', answer: null },
  }));
  const results = events.emitted.filter(event => event.channel === CONVERSATION_RESULT_EVENT || event.channel === ATTENTION_RESULT_EVENT)
    .map(event => event.data as EventRequestResultV1);
  assert.equal(results.length, 2);
  assert.ok(results.every(result => result.phase === 'rejected'));
  assert.ok(results.every(result => result.outcome.code === 'UNSUPPORTED_API'));
  assert.doesNotMatch(JSON.stringify(results), /SECRET-PROMPT|SECRET-ANSWER/);
  assert.equal(events.emitted.some(event => event.channel === 'optchat:conversation:input:v1'), false);
  coordinator.dispose();
});

test('main pings replay the current snapshot and reentrant listeners cannot create an unbounded loop', () => {
  const time = clock();
  const events = bus();
  const coordinator = owner(events, time);
  coordinator.ready();
  let reentered = false;
  events.api.on(MAIN_STATUS_EVENT, () => {
    if (!reentered) { reentered = true; coordinator.beginActivity(); }
  });
  coordinator.beginActivity();
  time.advance(250);
  const firstCount = events.emitted.filter(event => event.channel === MAIN_STATUS_EVENT).length;
  assert.ok(firstCount >= 2);
  time.advance(250);
  const secondCount = events.emitted.filter(event => event.channel === MAIN_STATUS_EVENT).length;
  assert.ok(secondCount > firstCount, 'the reentrant change is coalesced into one later publication');
  assert.ok(secondCount <= firstCount + 2);

  const beforePing = events.emitted.length;
  events.api.emit(MAIN_PING_EVENT, { late: true });
  time.advance(250);
  assert.ok(events.emitted.length > beforePing);
  coordinator.dispose();
});

test('a failed owner never advertises ready and disposal blocks later callbacks', () => {
  const time = clock();
  const events = bus();
  const coordinator = owner(events, time);
  assert.equal(events.emitted.some(event => event.channel === OWNER_EVENT), false);
  coordinator.dispose(false);
  assert.equal(events.emitted.some(event => event.channel === OWNER_EVENT), false);

  const second = owner(events, time, 'epoch-2');
  second.ready();
  second.dispose();
  assert.ok(events.emitted.some(event => event.channel === OWNER_EVENT && (event.data as OwnerEventV1).kind === 'closing'));
  const outputCount = () => events.emitted.filter(event => [OWNER_EVENT, MAIN_STATUS_EVENT, CONVERSATION_RESULT_EVENT, ATTENTION_RESULT_EVENT].includes(event.channel)).length;
  const afterDispose = outputCount();
  events.api.emit(MAIN_PING_EVENT, {});
  events.api.emit(CONVERSATION_REQUEST_EVENT, request({ ownerEpoch: 'epoch-2' }));
  assert.equal(outputCount(), afterDispose, 'nothing is published after disposal');
});
