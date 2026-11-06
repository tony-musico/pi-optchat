import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import {
  EVENT_LIMITS,
  OUTPUT_EVENT,
  OUTPUT_SUBSCRIBE_EVENT,
  OUTPUT_UNSUBSCRIBE_EVENT,
  type OutputEventV1,
} from '../src/events-contract.ts';
import { createOutputEvents, type OutputEventTimer } from '../src/output-events.ts';
import { emptyUsage } from '../src/usage.ts';

function clock() {
  let current = 10_000;
  let next = 1;
  const tasks = new Map<number, { at: number; run: () => void }>();
  const timer: OutputEventTimer = {
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
  return {
    emitted,
    api: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
        for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        const set = handlers.get(channel) ?? new Set();
        set.add(handler);
        handlers.set(channel, set);
        return () => { set.delete(handler); };
      },
    },
  };
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    usage: emptyUsage(),
    stopReason,
    timestamp: 1,
  };
}

function delta(text: string): AssistantMessageEvent {
  return { type: 'text_delta', contentIndex: 0, delta: text, partial: assistant([{ type: 'text', text }]) };
}

const subscribe = (subscriptionId: string, overrides: Record<string, unknown> = {}) => ({
  version: 1,
  clientId: 'client-1',
  requestId: `request-${subscriptionId}`,
  ownerSessionId: 'session-1',
  ownerEpoch: 'epoch-1',
  operation: 'output:subscribe',
  payload: { subscriptionId },
  ...overrides,
});

function output(busApi: ReturnType<typeof bus>, time: ReturnType<typeof clock>, contentEnabled = true) {
  let id = 0;
  return createOutputEvents({
    bus: busApi.api,
    ownerSessionId: 'session-1',
    ownerEpoch: 'epoch-1',
    contentEnabled,
    turnId: () => 'turn-1',
    now: time.now,
    timer: time.timer,
    idFactory: () => `generated-${++id}`,
  });
}

const outputEvents = (events: ReturnType<typeof bus>) => events.emitted
  .filter(event => event.channel === OUTPUT_EVENT)
  .map(event => event.data as OutputEventV1);

test('content-off rejects subscriptions and publishes no assistant text', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time, false);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  publisher.messageStart(assistant([{ type: 'text', text: 'SECRET-OFF' }]));
  publisher.messageUpdate(delta('SECRET-OFF'));
  publisher.messageEnd(assistant([{ type: 'text', text: 'SECRET-OFF' }]));
  const published = outputEvents(events);
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 'rejected');
  assert.equal(published[0].errorCode, 'DISABLED');
  assert.doesNotMatch(JSON.stringify(published), /SECRET-OFF/);
  publisher.dispose();
});

test('a new subscription acknowledges and receives a bounded retained final snapshot', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  publisher.messageStart(assistant([{ type: 'text', text: 'Hello' }]));
  publisher.messageEnd(assistant([{ type: 'text', text: 'Hello' }]));
  assert.equal(outputEvents(events).length, 0, 'no subscriber means no output event');
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  const published = outputEvents(events);
  assert.deepEqual(Object.keys(published[0]), [
    'version', 'ownerSessionId', 'ownerEpoch', 'clientId', 'subscriptionId', 'requestId',
    'turnId', 'messageId', 'sequence', 'kind', 'text', 'truncated', 'gap', 'replacement',
    'snapshotId', 'snapshotIndex', 'snapshotCount', 'errorCode',
  ]);
  assert.equal(published[0].kind, 'subscribed');
  assert.equal(published[1].kind, 'final');
  assert.equal(published[1].text, 'Hello');
  assert.equal(published[1].replacement, true);
  assert.ok(published[1].snapshotId);
  assert.equal(published[1].snapshotIndex, 0);
  assert.equal(published[1].snapshotCount, 1);
  publisher.dispose();
});

test('explicit resync replays the authoritative final without replaying deltas', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  publisher.messageStart(assistant([{ type: 'text', text: 'Final' }]));
  publisher.messageUpdate(delta('partial'));
  publisher.messageEnd(assistant([{ type: 'text', text: 'Final' }]));
  time.advance(100);
  const before = outputEvents(events).length;
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, {
    ...subscribe('subscription-1'),
    requestId: 'request-resync',
    operation: 'output:resync',
  });
  const published = outputEvents(events);
  assert.equal(published.length, before + 1);
  const resync = published.at(-1)!;
  assert.equal(resync.kind, 'final');
  assert.equal(resync.text, 'Final');
  assert.equal(resync.replacement, true);
  assert.equal(resync.requestId, 'request-resync');
  assert.equal(published.filter(event => event.kind === 'text_delta').length, 0, 'queued deltas were replaced by the final');
  publisher.dispose();
});

test('only assistant text deltas and allowlisted final text blocks are projected', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  publisher.messageStart(assistant([{ type: 'text', text: '' }]));
  publisher.messageUpdate({ type: 'thinking_delta', contentIndex: 0, delta: 'SECRET-THINKING', partial: assistant([]) });
  publisher.messageUpdate({ type: 'toolcall_delta', contentIndex: 0, delta: 'SECRET-TOOLARGS', partial: assistant([]) });
  publisher.messageUpdate(delta('safe text'));
  publisher.messageEnd(assistant([
    { type: 'text', text: 'safe text' },
    { type: 'thinking', thinking: 'SECRET-THINKING' },
    { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'SECRET-TOOLARGS' } },
  ], 'error'));
  time.advance(100);
  const published = outputEvents(events);
  const text = published.filter(event => event.kind === 'text_delta' || event.kind === 'final').map(event => event.text).join('');
  assert.match(text, /safe text/);
  assert.doesNotMatch(JSON.stringify(published), /SECRET-THINKING|SECRET-TOOLARGS|SECRET-ERROR/);
  assert.ok(published.some(event => event.kind === 'final'));
  publisher.dispose();
});

test('a no-delta assistant message still produces an authoritative final', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  publisher.messageStart(assistant([{ type: 'text', text: '' }]));
  publisher.messageEnd(assistant([{ type: 'text', text: 'No delta final' }]));
  const published = outputEvents(events);
  assert.equal(published.at(-1)?.kind, 'final');
  assert.equal(published.at(-1)?.text, 'No delta final');
  assert.equal(published.at(-1)?.replacement, true);
  publisher.dispose();
});

test('multiple assistant messages receive distinct generated ids and bounded resync state', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  publisher.messageStart(assistant([{ type: 'text', text: 'one' }]));
  publisher.messageEnd(assistant([{ type: 'text', text: 'one' }]));
  publisher.messageStart(assistant([{ type: 'text', text: 'two' }]));
  publisher.messageEnd(assistant([{ type: 'text', text: 'two' }]));
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  const finals = outputEvents(events).filter(event => event.kind === 'final');
  assert.deepEqual(finals.map(event => event.text), ['one', 'two']);
  assert.notEqual(finals[0].messageId, finals[1].messageId);
  assert.ok(finals.every(event => event.messageId?.startsWith('generated-')));
  publisher.dispose();
});

test('queued deltas keep the turn and message ids of their authoritative finals', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));

  publisher.messageStart(assistant([{ type: 'text', text: '' }]));
  publisher.messageUpdate(delta('first'));
  time.advance(100);
  publisher.messageEnd(assistant([{ type: 'text', text: 'first' }]));

  publisher.messageStart(assistant([{ type: 'text', text: '' }]));
  publisher.messageUpdate(delta('second'));
  time.advance(100);
  publisher.messageEnd(assistant([{ type: 'text', text: 'second' }]));

  const published = outputEvents(events);
  const deltas = published.filter(event => event.kind === 'text_delta');
  const finals = published.filter(event => event.kind === 'final');
  assert.equal(deltas.length, 2);
  assert.equal(finals.length, 2);
  assert.ok(deltas.every(event => event.turnId !== null && event.messageId !== null));
  assert.equal(deltas[0].turnId, finals[0].turnId);
  assert.equal(deltas[0].messageId, finals[0].messageId);
  assert.equal(deltas[1].turnId, finals[1].turnId);
  assert.equal(deltas[1].messageId, finals[1].messageId);
  assert.notEqual(deltas[0].messageId, deltas[1].messageId);
  publisher.dispose();
});

test('the recovery cache retains at most sixteen messages and marks eviction with a gap', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  for (let index = 0; index < 20; index++) {
    publisher.messageStart(assistant([{ type: 'text', text: String(index) }]));
    publisher.messageEnd(assistant([{ type: 'text', text: String(index) }]));
  }
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  const published = outputEvents(events);
  const finals = published.filter(event => event.kind === 'final');
  assert.equal(finals.length, 16);
  assert.deepEqual(finals.map(event => event.text), Array.from({ length: 16 }, (_value, index) => String(index + 4)));
  assert.ok(published.some(event => event.kind === 'gap' && event.gap));
  publisher.dispose();
});

test('delta batches wait 100ms, events stay within 8 KiB, and overflow emits a gap', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  publisher.messageStart(assistant([{ type: 'text', text: '' }]));
  publisher.messageUpdate(delta('a'.repeat(10_000)));
  time.advance(99);
  assert.equal(outputEvents(events).filter(event => event.kind === 'text_delta').length, 0);
  time.advance(1);
  let deltas = outputEvents(events).filter(event => event.kind === 'text_delta');
  assert.equal(deltas.length, 1);
  assert.ok(Buffer.byteLength(deltas[0].text, 'utf8') <= 8192);

  publisher.messageUpdate(delta('b'.repeat(EVENT_LIMITS.queuedDeltaBytes + 1)));
  time.advance(100);
  const published = outputEvents(events);
  assert.ok(published.some(event => event.kind === 'gap' && event.gap));
  assert.ok(published.every(event => Buffer.byteLength(event.text, 'utf8') <= 8192));
  publisher.messageEnd(assistant([{ type: 'text', text: 'authoritative' }]));
  const final = outputEvents(events).at(-1)!;
  assert.equal(final.kind, 'final');
  assert.equal(final.text, 'authoritative');
  assert.equal(final.replacement, true);
  publisher.dispose();
});

test('large Unicode finals are chunked without corrupting UTF-8', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  const text = '😀'.repeat(6_000);
  publisher.messageStart(assistant([{ type: 'text', text }]));
  publisher.messageEnd(assistant([{ type: 'text', text }]));
  const finals = outputEvents(events).filter(event => event.kind === 'final');
  assert.ok(finals.length > 1);
  assert.equal(finals.every(event => Buffer.byteLength(event.text, 'utf8') <= 8192), true);
  assert.equal(finals.map(event => event.text).join(''), text);
  assert.deepEqual(finals.map(event => event.snapshotIndex), finals.map((_event, index) => index));
  assert.ok(finals.every(event => event.snapshotCount === finals.length));
  publisher.dispose();
});

test('oversized Unicode text blocks are retained incrementally within the byte cap', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  const oversized = '😀'.repeat(70_000);
  publisher.messageStart(assistant([
    { type: 'text', text: oversized },
    { type: 'text', text: oversized },
  ]));
  publisher.messageEnd(assistant([
    { type: 'text', text: oversized },
    { type: 'text', text: oversized },
  ]));

  const finals = outputEvents(events).filter(event => event.kind === 'final');
  const retained = finals.map(event => event.text).join('');
  assert.ok(finals.length > 1);
  assert.ok(Buffer.byteLength(retained, 'utf8') <= 128 * 1024);
  assert.equal(retained.includes('�'), false);
  assert.equal(Buffer.from(retained, 'utf8').toString('utf8'), retained);
  assert.ok(finals.some(event => event.truncated));
  publisher.dispose();
});

test('subscriptions are leased, renewable, bounded, and owner/client scoped', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1', { requestId: 'renew' }));
  const renew = outputEvents(events).filter(event => event.kind === 'subscribed');
  assert.equal(renew.length, 2);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1', { clientId: 'client-2' }));
  assert.equal(outputEvents(events).at(-1)?.errorCode, 'REQUEST_CONFLICT');

  for (let index = 0; index < 8; index++) events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe(`subscription-${index + 2}`));
  assert.equal(outputEvents(events).at(-1)?.errorCode, 'CAPACITY');

  time.advance(5 * 60 * 1000);
  publisher.messageStart(assistant([{ type: 'text', text: '' }]));
  publisher.messageUpdate(delta('after expiry'));
  time.advance(100);
  assert.equal(outputEvents(events).filter(event => event.kind === 'text_delta').length, 0);
  publisher.dispose();
});

test('unsubscribe clears the subscription and disposal cancels pending output', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  publisher.messageStart(assistant([{ type: 'text', text: '' }]));
  publisher.messageUpdate(delta('pending'));
  events.api.emit(OUTPUT_UNSUBSCRIBE_EVENT, {
    ...subscribe('subscription-1'),
    requestId: 'request-unsubscribe',
    operation: 'output:unsubscribe',
  });
  assert.equal(outputEvents(events).at(-1)?.kind, 'unsubscribed');
  time.advance(100);
  assert.equal(outputEvents(events).filter(event => event.kind === 'text_delta').length, 0);

  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-2'));
  publisher.messageUpdate(delta('dispose pending'));
  const before = outputEvents(events).length;
  publisher.dispose();
  time.advance(100);
  assert.equal(outputEvents(events).length, before);
});

test('terminal activity facts occur only after settlement and use fixed outcomes', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  publisher.messageStart(assistant([{ type: 'text', text: 'failed text' }]));
  publisher.messageEnd(assistant([{ type: 'text', text: 'failed text' }], 'error'));
  assert.equal(outputEvents(events).some(event => event.kind === 'failed' || event.kind === 'completed'), false);
  publisher.settled(false);
  const failed = outputEvents(events).at(-1)!;
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.errorCode, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(failed), /provider|error message|SECRET/);

  publisher.messageStart(assistant([{ type: 'text', text: 'aborted' }]));
  publisher.messageEnd(assistant([{ type: 'text', text: 'aborted' }]));
  publisher.settled(true);
  assert.equal(outputEvents(events).at(-1)?.kind, 'aborted');
  publisher.dispose();
});

test('final replacement snapshots are authoritative and never masquerade as appended deltas', () => {
  const time = clock();
  const events = bus();
  const publisher = output(events, time);
  events.api.emit(OUTPUT_SUBSCRIBE_EVENT, subscribe('subscription-1'));
  publisher.messageStart(assistant([{ type: 'text', text: '' }]));
  publisher.messageUpdate(delta('partial'));
  publisher.messageEnd(assistant([{ type: 'text', text: 'complete' }]));
  const published = outputEvents(events);
  const final = published.find(event => event.kind === 'final')!;
  assert.equal(final.replacement, true);
  assert.equal(final.text, 'complete');
  assert.notEqual(final.kind, 'text_delta');
  assert.equal(published.filter(event => event.kind === 'final' && event.messageId === final.messageId).length, 1);
  publisher.dispose();
});
