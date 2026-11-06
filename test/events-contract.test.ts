import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ATTENTION_REPLY_EVENT,
  CONVERSATION_REQUEST_EVENT,
  EVENT_CHANNELS,
  EVENT_ERROR_CODES,
  EVENT_LIMITS,
  EVENTS_CONTENT_FLAG,
  EVENTS_CONTROL_FLAG,
  canonicalEventRequest,
  eventError,
  executableStringBytes,
  integrationsCapabilities,
  isIdentifier,
  parseEventRequest,
  parseOwnerEpochEnvelope,
  requestChannel,
  resultChannel,
  SUPPORTED_OPERATIONS,
  UNSUPPORTED_OPERATIONS,
  type EventOperation,
  type EventRequestV1,
} from '../src/events-contract.ts';

const base = {
  version: 1,
  clientId: 'discord-1',
  requestId: 'request-1',
  ownerSessionId: 'session-1',
  ownerEpoch: 'epoch-1',
} as const;

function parsed(value: unknown) {
  const result = parseEventRequest(value);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value;
}

test('channel names, flags, errors, and limits are literal and finite', () => {
  assert.deepEqual(EVENT_CHANNELS, {
    mainStatus: 'optchat:main:status:v1',
    mainPing: 'optchat:main:ping:v1',
    ownerEvent: 'optchat:owner:event:v1',
    conversationRequest: 'optchat:conversation:request:v1',
    conversationResult: 'optchat:conversation:result:v1',
    outputSubscribe: 'optchat:output:subscribe:v1',
    outputUnsubscribe: 'optchat:output:unsubscribe:v1',
    outputEvent: 'optchat:output:event:v1',
    attentionEvent: 'optchat:attention:event:v1',
    attentionReply: 'optchat:attention:reply:v1',
    attentionResult: 'optchat:attention:result:v1',
    agentRequest: 'optchat:agent:request:v1',
    agentResult: 'optchat:agent:result:v1',
    historyRequest: 'optchat:history:request:v1',
    historyResult: 'optchat:history:result:v1',
  });
  assert.equal(CONVERSATION_REQUEST_EVENT, 'optchat:conversation:request:v1');
  assert.equal(ATTENTION_REPLY_EVENT, 'optchat:attention:reply:v1');
  assert.equal(EVENTS_CONTENT_FLAG, 'optchat-events-content');
  assert.equal(EVENTS_CONTROL_FLAG, 'optchat-events-control');
  assert.deepEqual(EVENT_ERROR_CODES, [
    'INVALID_REQUEST', 'STALE_OWNER', 'STALE_RUN', 'DISABLED', 'UNSUPPORTED_API',
    'NOT_FOUND', 'INVALID_STATE', 'POLICY_DENIED', 'CAPACITY', 'REQUEST_CONFLICT',
    'OUTCOME_UNKNOWN', 'OWNER_CLOSING', 'INTERNAL_ERROR',
  ]);
  assert.deepEqual(EVENT_LIMITS, {
    executableStringBytes: 65536,
    inputTextBytes: 32768,
    spawnTasks: 8,
    inFlightRequests: 16,
    idempotencyRecords: 256,
    retainedResultBytes: 4194304,
    retryWindowMs: 600000,
    operationDeadlineMs: 30000,
    metadataCoalesceMs: 250,
    outputSubscriptions: 8,
    retainedMessageBytes: 131072,
    retainedMessages: 16,
    recoveryCacheBytes: 524288,
    outputEventBytes: 8192,
    outputBatchIntervalMs: 100,
    queuedDeltaBytes: 32768,
    historyItems: 20,
    historyPageBytes: 65536,
    historyItemBytes: 16384,
    historyCandidates: 200,
    historyCursors: 16,
    historyCursorBytes: 524288,
    historyCursorTtlMs: 60000,
    runResultTextBytes: 32768,
  });
});

test('the additive integrations capability has exact keys and independent default-off flags', () => {
  const capability = integrationsCapabilities('epoch-1', { content: false, control: false });
  assert.ok(capability);
  assert.deepEqual(Object.keys(capability), ['version', 'ownerEpoch', 'metadata', 'content', 'control', 'unsupported', 'limits']);
  assert.deepEqual(Object.keys(capability.metadata), ['enabled']);
  assert.deepEqual(Object.keys(capability.content), ['enabled']);
  assert.deepEqual(Object.keys(capability.control), ['enabled']);
  assert.equal(capability.metadata.enabled, true);
  assert.equal(capability.content.enabled, false);
  assert.equal(capability.control.enabled, false);
  assert.deepEqual(capability.unsupported.map(item => item.operation), [
    'conversation:submit', 'conversation:queue', 'conversation:steer', 'attention:reply',
  ]);
  assert.ok(capability.unsupported.every(item => item.reason === 'PUBLIC_API_LIMIT'));
  assert.equal(integrationsCapabilities('epoch-1', { content: true, control: false })?.content.enabled, true);
  assert.equal(integrationsCapabilities('epoch-1', { content: false, control: true })?.control.enabled, true);
  assert.equal(integrationsCapabilities('not valid', { content: true, control: true }), undefined);
});

test('the capability publishes the queued delta buffer ceiling without a per-second budget', () => {
  const capability = integrationsCapabilities('epoch-1', { content: false, control: false });
  assert.ok(capability);
  assert.equal(capability.limits.queuedDeltaBytes, 32768);
  assert.equal('queuedDeltaBytes' in capability.limits, true);
  const obsoletePerSecondKey = ['queuedDeltaBytes', 'PerSecond'].join('');
  assert.equal(obsoletePerSecondKey in capability.limits, false);
  assert.equal(obsoletePerSecondKey in EVENT_LIMITS, false);
});

test('a request becomes an exact-key allowlisted DTO', () => {
  const request = parsed({
    ...base,
    operation: 'agent:spawn',
    payload: {
      tasks: [{ task: 'Do the work', model: 'fixture/model', thinking: 'medium', future: 'ignored' }],
      future: 'ignored',
    },
    future: 'ignored',
  });
  assert.deepEqual(Object.keys(request), ['version', 'clientId', 'requestId', 'ownerSessionId', 'ownerEpoch', 'operation', 'payload']);
  if (request.operation !== 'agent:spawn') assert.fail('wrong operation');
  assert.deepEqual(Object.keys(request.payload), ['tasks']);
  assert.deepEqual(Object.keys(request.payload.tasks[0]), ['task', 'model', 'thinking']);
  assert.deepEqual(request.payload.tasks[0], { task: 'Do the work', model: 'fixture/model', thinking: 'medium' });
});

test('unknown additive fields are ignored and never enter the canonical semantics', () => {
  const sentinel = 'UNKNOWN-ADDITIVE-SENTINEL';
  const request = parsed({
    ...base,
    operation: 'output:subscribe',
    payload: { subscriptionId: 'subscription-1', future: sentinel },
    future: sentinel,
  });
  assert.equal(JSON.stringify(request).includes(sentinel), false);
  assert.equal(canonicalEventRequest(request).includes(sentinel), false);
  assert.equal(canonicalEventRequest(request), '{"operation":"output:subscribe","payload":{"subscriptionId":"subscription-1"}}');
});

test('the canonical semantics include the operation and validated payload only', () => {
  const spawn = parsed({ ...base, operation: 'agent:spawn', payload: { tasks: [{ task: 'same' }] } });
  const target = parsed({ ...base, operation: 'agent:stop', payload: { runId: 'run-1', expectedStartedAt: 1 } });
  assert.notEqual(canonicalEventRequest(spawn), canonicalEventRequest(target));
  assert.equal(canonicalEventRequest(target), '{"operation":"agent:stop","payload":{"runId":"run-1","expectedStartedAt":1}}');
});

test('unsupported versions and operations use fixed safe errors', () => {
  const version = parseEventRequest({ ...base, version: 2, operation: 'agent:stop', payload: { runId: 'run-1', expectedStartedAt: 1 } });
  assert.equal(version.ok, false);
  assert.equal(version.ok ? '' : version.error, 'UNSUPPORTED_API');
  const operation = parseEventRequest({ ...base, operation: 'agent:teleport', payload: {} });
  assert.equal(operation.ok, false);
  assert.equal(operation.ok ? '' : operation.error, 'UNSUPPORTED_API');
  assert.equal(JSON.stringify(operation).includes('teleport'), false);
});

test('missing identifiers and epochs are distinguished without echoing a payload', () => {
  const missingId = parseEventRequest({ ...base, clientId: undefined, operation: 'agent:stop', payload: { runId: 'run-1', expectedStartedAt: 1 } });
  assert.equal(missingId.ok, false);
  assert.equal(missingId.ok ? '' : missingId.error, 'INVALID_REQUEST');
  const missingEpoch = parseEventRequest({ ...base, ownerEpoch: undefined, operation: 'agent:stop', payload: { runId: 'run-1', expectedStartedAt: 1 } });
  assert.equal(missingEpoch.ok, false);
  assert.equal(missingEpoch.ok ? '' : missingEpoch.error, 'STALE_OWNER');
  const missingRequest = parseEventRequest({ ...base, requestId: undefined, operation: 'agent:stop', payload: { runId: 'run-1', expectedStartedAt: 1 } });
  assert.equal(missingRequest.ok, false);
  assert.equal(missingRequest.ok ? '' : missingRequest.error, 'INVALID_REQUEST');
});

test('non-finite and out-of-range executable numbers are rejected', () => {
  for (const expectedStartedAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5]) {
    const result = parseEventRequest({ ...base, operation: 'agent:stop', payload: { runId: 'run-1', expectedStartedAt } });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.error, 'INVALID_REQUEST');
  }
  const limit = parseEventRequest({ ...base, operation: 'history:recent', payload: { limit: 21 } });
  assert.equal(limit.ok, false);
  assert.equal(limit.ok ? '' : limit.error, 'INVALID_REQUEST');
});

test('ASCII, Unicode, and JSON-escaped executable text is bounded by UTF-8 bytes', () => {
  const ascii = parseEventRequest({ ...base, operation: 'conversation:submit', payload: { text: 'a'.repeat(EVENT_LIMITS.inputTextBytes + 1) } });
  assert.equal(ascii.ok, false);
  assert.equal(ascii.ok ? '' : ascii.error, 'CAPACITY');

  const unicode = parseEventRequest({ ...base, operation: 'conversation:submit', payload: { text: '😀'.repeat(EVENT_LIMITS.inputTextBytes / 4 + 1) } });
  assert.equal(unicode.ok, false);
  assert.equal(unicode.ok ? '' : unicode.error, 'CAPACITY');

  const escaped = parseEventRequest({ ...base, operation: 'conversation:submit', payload: { text: '\n'.repeat(EVENT_LIMITS.inputTextBytes) } });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.ok ? '' : escaped.error, 'CAPACITY');

  const aggregate = parseEventRequest({
    ...base,
    operation: 'agent:spawn',
    payload: { tasks: [
      { task: 'a'.repeat(EVENT_LIMITS.inputTextBytes) },
      { task: 'b'.repeat(EVENT_LIMITS.inputTextBytes) },
    ] },
  });
  assert.equal(aggregate.ok, false);
  assert.equal(aggregate.ok ? '' : aggregate.error, 'CAPACITY');
});

test('known throwing getters fail closed and unknown throwing getters are ignored', () => {
  let calls = 0;
  const payload = {};
  Object.defineProperty(payload, 'subscriptionId', { enumerable: true, get() { calls++; throw new Error('SECRET-ERROR-TEXT'); } });
  const known = parseEventRequest({ ...base, operation: 'output:subscribe', payload });
  assert.equal(known.ok, false);
  assert.equal(known.ok ? '' : known.error, 'INVALID_REQUEST');
  assert.equal(calls, 0);

  const additive = { subscriptionId: 'subscription-1' };
  Object.defineProperty(additive, 'future', { enumerable: true, get() { calls++; throw new Error('SECRET-ERROR-TEXT'); } });
  const unknown = parseEventRequest({ ...base, operation: 'output:subscribe', payload: additive });
  assert.ok(unknown.ok);
  assert.equal(calls, 0);
});

test('caller cwd and parent impersonation are rejected before dispatch', () => {
  for (const payload of [
    { subscriptionId: 'subscription-1', cwd: '/tmp/elsewhere' },
    { subscriptionId: 'subscription-1', callerCwd: '/tmp/elsewhere' },
    { subscriptionId: 'subscription-1', parent: 'client-1' },
    { subscriptionId: 'subscription-1', tasks: [{ task: 'x', parentId: 'client-1' }] },
  ]) {
    const result = parseEventRequest({ ...base, operation: 'agent:spawn', payload });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.error, 'POLICY_DENIED');
  }
  const topLevel = parseEventRequest({ ...base, operation: 'agent:stop', cwd: '/tmp/elsewhere', payload: { runId: 'run-1', expectedStartedAt: 1 } });
  assert.equal(topLevel.ok, false);
  assert.equal(topLevel.ok ? '' : topLevel.error, 'POLICY_DENIED');
});

test('task, prompt, and error sentinels never reach metadata or fixed diagnostics', () => {
  const taskSentinel = 'SECRET-TASK-TEXT';
  const promptSentinel = 'SECRET-PROMPT-TEXT';
  const errorSentinel = 'SECRET-ERROR-TEXT';
  const capability = integrationsCapabilities('epoch-1', { content: false, control: false });
  assert.ok(capability);
  const capabilityText = JSON.stringify(capability);
  assert.doesNotMatch(capabilityText, new RegExp(taskSentinel));
  assert.doesNotMatch(capabilityText, new RegExp(promptSentinel));
  assert.doesNotMatch(capabilityText, new RegExp(errorSentinel));

  const failure = parseEventRequest({
    ...base,
    operation: 'output:subscribe',
    payload: { subscriptionId: 'subscription-1', task: taskSentinel, prompt: promptSentinel, error: errorSentinel },
  });
  assert.ok(failure.ok);
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(taskSentinel));
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(promptSentinel));
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(errorSentinel));

  const error = eventError('INTERNAL_ERROR');
  assert.deepEqual(Object.keys(error), ['code', 'message']);
  assert.equal(error.message, 'OptChat event integration failed internally.');
  assert.doesNotMatch(JSON.stringify(error), new RegExp(errorSentinel));
});

test('the owner epoch envelope is exact-key and rejects an old or malformed epoch', () => {
  const envelope = parseOwnerEpochEnvelope({ version: 1, ownerSessionId: 'session-1', ownerEpoch: 'epoch-1', future: true });
  assert.ok(envelope.ok);
  assert.deepEqual(Object.keys(envelope.value), ['version', 'ownerSessionId', 'ownerEpoch']);
  const stale = parseOwnerEpochEnvelope({ version: 1, ownerSessionId: 'session-1', ownerEpoch: '' });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok ? '' : stale.error, 'STALE_OWNER');
});

test('the documented operation table matches the exact request and result channel mapping', () => {
  const expectedRequest: Record<EventOperation, string> = {
    'output:subscribe': 'optchat:output:subscribe:v1',
    'output:unsubscribe': 'optchat:output:unsubscribe:v1',
    'output:resync': 'optchat:output:subscribe:v1',
    'agent:spawn': 'optchat:agent:request:v1',
    'agent:steer': 'optchat:agent:request:v1',
    'agent:stop': 'optchat:agent:request:v1',
    'agent:resume': 'optchat:agent:request:v1',
    'history:recent': 'optchat:history:request:v1',
    'history:result': 'optchat:history:request:v1',
    'conversation:submit': 'optchat:conversation:request:v1',
    'conversation:queue': 'optchat:conversation:request:v1',
    'conversation:steer': 'optchat:conversation:request:v1',
    'attention:reply': 'optchat:attention:reply:v1',
  };
  const expectedResult: Record<EventOperation, string> = {
    'output:subscribe': 'optchat:output:event:v1',
    'output:unsubscribe': 'optchat:output:event:v1',
    'output:resync': 'optchat:output:event:v1',
    'agent:spawn': 'optchat:agent:result:v1',
    'agent:steer': 'optchat:agent:result:v1',
    'agent:stop': 'optchat:agent:result:v1',
    'agent:resume': 'optchat:agent:result:v1',
    'history:recent': 'optchat:history:result:v1',
    'history:result': 'optchat:history:result:v1',
    'conversation:submit': 'optchat:conversation:result:v1',
    'conversation:queue': 'optchat:conversation:result:v1',
    'conversation:steer': 'optchat:conversation:result:v1',
    'attention:reply': 'optchat:attention:result:v1',
  };
  const operations = [...SUPPORTED_OPERATIONS, ...UNSUPPORTED_OPERATIONS];
  const guide = readFileSync(new URL('../docs/events-integration.md', import.meta.url), 'utf8');
  for (const operation of operations) {
    assert.equal(requestChannel(operation), expectedRequest[operation], `${operation} request channel`);
    assert.equal(resultChannel(operation), expectedResult[operation], `${operation} result channel`);
    const row = guide.split('\n').find(line => line.startsWith(`| \`${operation}\` |`));
    assert.ok(row, `missing documented operation row for ${operation}`);
    assert.ok(row.includes(`\`${expectedRequest[operation]}\``), `${operation} documented request channel`);
    assert.ok(guide.includes(`\`${expectedResult[operation]}\``), `${operation} documented result channel`);
  }
  const attentionRow = guide.split('\n').find(line => line.startsWith('| `attention:reply` |'));
  assert.ok(attentionRow?.includes('{ "attentionId": "attention-id", "answer": null }'));

  const attention = parsed({
    ...base,
    operation: 'attention:reply',
    payload: { attentionId: 'attention-1', answer: null },
  });
  if (attention.operation !== 'attention:reply') assert.fail('wrong operation');
  assert.deepEqual(attention.payload, { attentionId: 'attention-1', answer: null });
});

test('identifier and executable-byte helpers are conservative', () => {
  assert.equal(isIdentifier('a'), true);
  assert.equal(isIdentifier('a-b_c.1'), true);
  assert.equal(isIdentifier('-bad'), false);
  assert.equal(isIdentifier('bad space'), false);
  assert.equal(isIdentifier('x'.repeat(129)), false);
  const request = parsed({ ...base, operation: 'agent:stop', payload: { runId: 'run-1', expectedStartedAt: 1 } }) as EventRequestV1;
  assert.ok(executableStringBytes(request) > 0);
  assert.ok(executableStringBytes(request) <= EVENT_LIMITS.executableStringBytes);
});
