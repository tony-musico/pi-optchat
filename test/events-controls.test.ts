import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children, type Task } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { AGENT_RESULT_EVENT, HISTORY_RESULT_EVENT, type EventRequestResultV1 } from '../src/events-contract.ts';
import {
  createEventControls,
  type ControlChildren,
  type ControlLiveRun,
  type EventControlsOptions,
} from '../src/events-controls.ts';
import type { RequestTimer } from '../src/events-requests.ts';
import type { RunInfo } from '../src/runs.ts';
import { removeDir } from './support.ts';

const until = async (predicate: () => boolean, what: string) => {
  for (let index = 0; index < 1000 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), what);
};

function clock() {
  let current = 10_000;
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
      const untilAt = current + ms;
      for (;;) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= untilAt).sort((a, b) => a[0] - b[0])[0];
        if (!due) break;
        current = due[1].at;
        tasks.delete(due[0]);
        due[1].run();
      }
      current = untilAt;
    },
  };
}

function run(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    id: 'run-1', task: 'Task', cwd: '/owner', model: 'fixture/fixture', thinking: 'off',
    parentSession: 'session-1', started: 100, depth: 1, state: 'running', guidance: [],
    ...overrides,
  };
}

class FakeChildren implements ControlChildren {
  readonly ids: string[] = [];
  readonly history = { records: new Map<string, RunInfo>() };
  readonly liveRuns = new Map<string, ControlLiveRun>();
  readonly spawnCalls: { tasks: Task[]; cwd: string; signal?: AbortSignal; parentId?: string; connected?: boolean }[] = [];
  readonly tellCalls: { id: string; message: string; source?: 'manager' | 'user'; caller?: string; options?: { allowResume?: boolean } }[] = [];
  readonly stopCalls: string[] = [];
  readonly retainedCalls: string[] = [];
  readonly retainedMessages = new Map<string, readonly { role: string; content?: unknown }[]>();
  spawnResult: string[] = ['run-new'];
  spawnPromise: Promise<string[]> | undefined;
  tellImplementation: (id: string, message: string, source?: 'manager' | 'user', caller?: string, options?: { allowResume?: boolean }) => Promise<string> = async () => 'queued';

  live(id: string) { return this.liveRuns.get(id); }
  async spawn(tasks: Task[], cwd: string, signal?: AbortSignal, parentId?: string, connected?: boolean) {
    this.spawnCalls.push({ tasks, cwd, signal, parentId, connected });
    return this.spawnPromise ?? this.spawnResult;
  }
  async tell(id: string, message: string, source?: 'manager' | 'user', caller?: string, options?: { allowResume?: boolean }) {
    this.tellCalls.push({ id, message, source, caller, options });
    return this.tellImplementation(id, message, source, caller, options);
  }
  async stop(id: string) { this.stopCalls.push(id); }
  retained(id: string) {
    this.retainedCalls.push(id);
    return this.retainedMessages.get(id) ?? [];
  }
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

function harness(options: {
  children?: FakeChildren;
  contentEnabled?: boolean;
  controlEnabled?: boolean;
  branch?: () => readonly { type: string; id: string; message?: { role: string; content?: unknown } }[];
  models?: { name: string; thinking: ('off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[] }[];
  maxAgents?: number;
  subagentLevels?: number;
  time?: ReturnType<typeof clock>;
} = {}) {
  const time = options.time ?? clock();
  const children = options.children ?? new FakeChildren();
  const events = bus();
  const controls = createEventControls({
    bus: events.api,
    ownerSessionId: 'session-1',
    ownerEpoch: 'epoch-1',
    contentEnabled: options.contentEnabled !== false,
    controlEnabled: options.controlEnabled !== false,
    children,
    cwd: '/owner',
    branch: options.branch ?? (() => []),
    models: () => options.models ?? [{ name: 'fixture/fixture', thinking: ['off', 'medium'] }],
    maxAgents: options.maxAgents,
    subagentLevels: options.subagentLevels ?? 1,
    now: time.now,
    timer: time.timer,
  } satisfies EventControlsOptions);
  const results = () => events.emitted.filter(event => event.channel === AGENT_RESULT_EVENT).map(event => event.data as EventRequestResultV1);
  const historyResults = () => events.emitted.filter(event => event.channel === HISTORY_RESULT_EVENT).map(event => event.data as EventRequestResultV1);
  const terminal = () => results().find(result => result.phase === 'completed');
  return { time, children, events, controls, results, historyResults, terminal };
}

const request = (operation: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
  version: 1,
  clientId: 'client-1',
  requestId: `request-${operation.replace(':', '-')}`,
  ownerSessionId: 'session-1',
  ownerEpoch: 'epoch-1',
  operation,
  payload,
  ...overrides,
});

const spawnPayload = { tasks: [{ task: 'Do work', model: 'fixture/fixture', thinking: 'off' }] };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const historyRequest = (payload: unknown, overrides: Record<string, unknown> = {}) => request(
  'history:recent',
  payload,
  { requestId: `history-${Math.random().toString(36).slice(2)}`, ...overrides },
);

const resultRequest = (payload: unknown, overrides: Record<string, unknown> = {}) => request(
  'history:result',
  payload,
  { requestId: `result-${Math.random().toString(36).slice(2)}`, ...overrides },
);

const branchMessage = (id: string, role: string, content: unknown) => ({ type: 'message', id, message: { role, content } });

test('disabled control rejects before any child, model, or filesystem work', async () => {
  const h = harness({ controlEnabled: false });
  h.events.api.emit('optchat:agent:request:v1', request('agent:spawn', spawnPayload));
  await until(() => h.results().length === 1, 'disabled result');
  assert.equal(h.results()[0].phase, 'rejected');
  assert.equal(h.results()[0].outcome.code, 'DISABLED');
  assert.equal(h.children.spawnCalls.length, 0);
  h.controls.dispose();
});

test('spawn returns the run ids and each run\'s generation token, and executes exactly once on replay', async () => {
  const h = harness();
  h.events.api.emit('optchat:agent:request:v1', request('agent:spawn', spawnPayload));
  await until(() => h.terminal() !== undefined, 'spawn terminal');
  assert.deepEqual(h.terminal()?.outcome.value, { runIds: ['run-new'], runs: [{ runId: 'run-new', startedAt: null }] });
  assert.equal(h.children.spawnCalls.length, 1);
  assert.equal(h.children.spawnCalls[0].cwd, '/owner');
  assert.equal(h.children.spawnCalls[0].parentId, undefined);
  assert.equal(h.children.spawnCalls[0].connected, false);
  assert.deepEqual(h.children.spawnCalls[0].tasks, [{ task: 'Do work', model: 'fixture/fixture', thinking: 'off' }]);

  h.events.api.emit('optchat:agent:request:v1', request('agent:spawn', spawnPayload));
  await until(() => h.results().filter(result => result.phase === 'completed').length === 2, 'terminal replay');
  assert.equal(h.children.spawnCalls.length, 1, 'the same request never spawns twice');

  h.events.api.emit('optchat:agent:request:v1', request('agent:spawn', { tasks: [{ task: 'Different', model: 'fixture/fixture', thinking: 'off' }] }));
  await until(() => h.results().some(result => result.outcome.code === 'REQUEST_CONFLICT'), 'conflict');
  assert.equal(h.children.spawnCalls.length, 1);
  h.controls.dispose();
});

test('a request that echoes a published generation token is accepted, and one that does not is stale', async () => {
  const h = harness();
  const started = 1_700_000_000_000;
  const spawned = run({ id: 'run-new', started, state: 'running' });
  h.children.liveRuns.set(spawned.id, { info: spawned });
  h.children.ids.push(spawned.id);
  h.events.api.emit('optchat:agent:request:v1', request('agent:spawn', spawnPayload));
  await until(() => h.terminal() !== undefined, 'spawn terminal');
  assert.deepEqual(h.terminal()?.outcome.value, { runIds: ['run-new'], runs: [{ runId: 'run-new', startedAt: started }] });

  h.events.api.emit('optchat:agent:request:v1', request('agent:stop', { runId: spawned.id, expectedStartedAt: started }, { requestId: 'stop-token' }));
  await until(() => h.results().some(result => result.requestId === 'stop-token' && result.phase === 'completed'), 'stop terminal');
  assert.deepEqual(h.results().find(result => result.requestId === 'stop-token' && result.phase === 'completed')?.outcome.value, { runId: spawned.id, accepted: 'stop-requested' });

  h.events.api.emit('optchat:agent:request:v1', request('agent:stop', { runId: spawned.id, expectedStartedAt: started - 1 }, { requestId: 'stop-stale' }));
  await until(() => h.results().some(result => result.requestId === 'stop-stale' && result.phase === 'rejected'), 'stale rejection');
  assert.equal(h.results().find(result => result.requestId === 'stop-stale')?.outcome.code, 'STALE_RUN');
  assert.deepEqual(h.children.stopCalls, [spawned.id], 'only the request that carried the token stopped the run');
  h.controls.dispose();
});

test('steer, stop, and resume validate ownership and return IDs-only action facts', async () => {
  const h = harness();
  const live = run({ id: 'live-1', started: 100, state: 'running' });
  h.children.liveRuns.set(live.id, { info: live });
  h.children.ids.push(live.id);
  h.events.api.emit('optchat:agent:request:v1', request('agent:steer', { runId: live.id, expectedStartedAt: 100, message: 'Continue safely' }));
  await until(() => h.terminal()?.outcome.value !== undefined, 'steer terminal');
  assert.deepEqual(h.terminal()?.outcome.value, { runId: live.id, accepted: 'steered' });
  assert.deepEqual(h.children.tellCalls[0].options, { allowResume: false });

  h.events.api.emit('optchat:agent:request:v1', request('agent:stop', { runId: live.id, expectedStartedAt: 100 }, { requestId: 'request-stop' }));
  await until(() => h.results().some(result => result.requestId === 'request-stop' && result.phase === 'completed'), 'stop terminal');
  assert.deepEqual(h.results().find(result => result.requestId === 'request-stop' && result.phase === 'completed')?.outcome.value, { runId: live.id, accepted: 'stop-requested' });
  assert.deepEqual(h.children.stopCalls, [live.id]);

  const finished = run({ id: 'finished-1', started: 200, state: 'completed' });
  h.children.history.records.set(finished.id, finished);
  h.events.api.emit('optchat:agent:request:v1', request('agent:resume', { runId: finished.id, expectedStartedAt: 200, message: 'Resume safely' }, { requestId: 'request-resume' }));
  await until(() => h.results().some(result => result.requestId === 'request-resume' && result.phase === 'completed'), 'resume terminal');
  assert.deepEqual(h.results().find(result => result.requestId === 'request-resume' && result.phase === 'completed')?.outcome.value, { runId: finished.id, accepted: 'resumed' });
  assert.equal(h.children.tellCalls[1].source, 'manager');
  assert.notEqual(h.children.tellCalls[1].options?.allowResume, false);
  h.controls.dispose();
});

test('stale owners and run generations, nested runs, and connected runs are rejected without mutation', async () => {
  const h = harness();
  const nested = run({ id: 'nested-1', parentId: 'parent-1', depth: 2 });
  const connected = run({ id: 'connected-1', connected: true });
  const staleRun = run({ id: 'stale-1', started: 100, state: 'running' });
  h.children.liveRuns.set(nested.id, { info: nested });
  h.children.liveRuns.set(connected.id, { info: connected });
  h.children.liveRuns.set(staleRun.id, { info: staleRun });
  const cases = [
    [request('agent:steer', { runId: nested.id, expectedStartedAt: 100, message: 'x' }), 'POLICY_DENIED'],
    [request('agent:steer', { runId: connected.id, expectedStartedAt: 100, message: 'x' }), 'POLICY_DENIED'],
    [request('agent:steer', { runId: 'missing', expectedStartedAt: 100, message: 'x' }), 'NOT_FOUND'],
  ] as const;
  for (const [value, code] of cases) {
    h.events.api.emit('optchat:agent:request:v1', value);
    await until(() => h.results().some(result => result.outcome.code === code), `rejection ${code}`);
  }
  const stale = request('agent:steer', { runId: 'missing', expectedStartedAt: 100, message: 'x' }, { ownerEpoch: 'old-epoch' });
  h.events.api.emit('optchat:agent:request:v1', stale);
  await until(() => h.results().some(result => result.outcome.code === 'STALE_OWNER'), 'stale owner');
  const generation = request('agent:steer', { runId: staleRun.id, expectedStartedAt: 999, message: 'x' }, { requestId: 'generation' });
  h.events.api.emit('optchat:agent:request:v1', generation);
  await until(() => h.results().some(result => result.requestId === 'generation' && result.outcome.code === 'STALE_RUN'), 'stale generation');
  assert.equal(h.children.tellCalls.length, 0);
  h.controls.dispose();
});

test('caller cwd, missing model/thinking, unsupported models, depth, and capacity are rejected before spawn', async () => {
  const h = harness({ maxAgents: 1 });
  const requests = [
    request('agent:spawn', { tasks: [{ task: 'x', model: 'fixture/fixture', thinking: 'off', cwd: '/elsewhere' }] }),
    request('agent:spawn', { tasks: [{ task: 'x', model: null, thinking: null }] }, { requestId: 'missing-model' }),
    request('agent:spawn', { tasks: [{ task: 'x', model: 'other/model', thinking: 'off' }] }, { requestId: 'unknown-model' }),
    request('agent:spawn', { tasks: [{ task: 'x', model: 'fixture/fixture', thinking: 'high' }] }, { requestId: 'thinking' }),
  ];
  for (const value of requests) {
    h.events.api.emit('optchat:agent:request:v1', value);
    await until(() => h.results().some(result => result.requestId === value.requestId && result.phase === 'rejected'), `rejected ${value.requestId}`);
  }
  assert.ok(h.results().some(result => result.requestId === 'missing-model' && result.outcome.code === 'INVALID_REQUEST'));
  assert.ok(h.results().some(result => result.requestId === 'unknown-model' && result.outcome.code === 'NOT_FOUND'));
  assert.ok(h.results().some(result => result.requestId === 'thinking' && result.outcome.code === 'POLICY_DENIED'));
  assert.equal(h.children.spawnCalls.length, 0);

  h.children.ids.push('existing-run');
  h.events.api.emit('optchat:agent:request:v1', request('agent:spawn', spawnPayload, { requestId: 'capacity' }));
  await until(() => h.results().some(result => result.requestId === 'capacity' && result.outcome.code === 'CAPACITY'), 'capacity rejection');
  assert.equal(h.children.spawnCalls.length, 0);

  const deep = harness({ subagentLevels: 0 });
  deep.events.api.emit('optchat:agent:request:v1', request('agent:spawn', spawnPayload));
  await until(() => deep.results().some(result => result.outcome.code === 'POLICY_DENIED'), 'depth rejection');
  assert.equal(deep.children.spawnCalls.length, 0);
  deep.controls.dispose();
  h.controls.dispose();
});

test('a steer completion race cannot turn into an implicit resume', async () => {
  const h = harness();
  const live = run({ id: 'race-1', started: 100, state: 'running' });
  h.children.liveRuns.set(live.id, { info: live });
  h.children.ids.push(live.id);
  h.children.tellImplementation = async (_id, _message, _source, _caller, options) => {
    h.children.liveRuns.delete('race-1');
    h.children.history.records.set('race-1', run({ id: 'race-1', started: 100, state: 'completed' }));
    return options?.allowResume === false ? 'queued without resume' : 'resumed';
  };
  h.events.api.emit('optchat:agent:request:v1', request('agent:steer', { runId: live.id, expectedStartedAt: 100, message: 'race' }));
  await until(() => h.terminal() !== undefined, 'race terminal');
  assert.deepEqual(h.terminal()?.outcome.value, { runId: live.id, accepted: 'steered' });
  assert.equal(h.children.tellCalls[0].options?.allowResume, false);
  h.controls.dispose();
});

test('a mutation timeout stays uncertain, keeps its slot, and suppresses late settlement', async () => {
  const h = harness();
  let resolveSpawn!: (ids: string[]) => void;
  h.children.spawnPromise = new Promise(resolve => { resolveSpawn = resolve; });
  h.events.api.emit('optchat:agent:request:v1', request('agent:spawn', spawnPayload));
  await until(() => h.results().some(result => result.phase === 'accepted'), 'accepted');
  h.time.advance(30_000);
  await until(() => h.results().some(result => result.phase === 'completed' && result.outcome.code === 'OUTCOME_UNKNOWN'), 'unknown outcome');
  assert.equal(h.children.spawnCalls.length, 1);
  resolveSpawn(['late-run']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.results().filter(result => result.phase === 'completed').length, 1, 'late settlement is suppressed');

  h.events.api.emit('optchat:agent:request:v1', request('agent:spawn', spawnPayload, { requestId: 'new-id' }));
  await until(() => h.results().some(result => result.requestId === 'new-id' && result.outcome.code === 'OUTCOME_UNKNOWN'), 'new id blocked');
  assert.equal(h.children.spawnCalls.length, 1);
  h.controls.dispose();
});

test('teardown during launch aborts the adapter and blocks the late result', async () => {
  const h = harness();
  let resolveSpawn!: (ids: string[]) => void;
  h.children.spawnPromise = new Promise(resolve => { resolveSpawn = resolve; });
  h.events.api.emit('optchat:agent:request:v1', request('agent:spawn', spawnPayload));
  await until(() => h.children.spawnCalls.length === 1, 'spawn started');
  assert.equal(h.children.spawnCalls[0].signal?.aborted, false);
  h.controls.dispose();
  assert.equal(h.children.spawnCalls[0].signal?.aborted, true);
  resolveSpawn(['late-run']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.results().filter(result => result.phase === 'completed').length, 1);
  assert.equal(h.results().find(result => result.phase === 'completed')?.outcome.code, 'OWNER_CLOSING');
});

const roots: string[] = [];
after(() => { for (const root of roots) removeDir(root); });

test('the real Children tell helper refuses implicit resume when allowResume is false', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-controls-'));
  roots.push(root);
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple: () => { throw new Error('must not call the model'); },
  });
  const memory = new Memory(join(root, 'profile'), async () => 'summary', () => {});
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => '', async () => {}, () => {}, join(root, 'profile'));
  try {
    const finished = run({ id: 'finished-real', task: '', cwd: root, parentSession: 'session-1', started: 1, state: 'completed' });
    children.history.save(finished);
    await assert.rejects(children.tell(finished.id, 'resume', 'manager', undefined, { allowResume: false }), /not running/);
    assert.equal(children.history.records.get(finished.id)?.state, 'completed');
    assert.equal(children.live(finished.id), undefined);
  } finally {
    await children.close();
    await memory.close();
  }
});

test('content-disabled history reads reject before branch or retained sources are read', async () => {
  const children = new FakeChildren();
  let branchReads = 0;
  const h = harness({
    children,
    contentEnabled: false,
    branch: () => { branchReads += 1; return []; },
  });
  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 10, cursor: null }));
  h.events.api.emit('optchat:history:request:v1', resultRequest({ runId: 'run-1', expectedStartedAt: 100 }));
  await until(() => h.historyResults().length === 2, 'disabled history results');
  assert.deepEqual(h.historyResults().map(result => result.outcome.code), ['DISABLED', 'DISABLED']);
  assert.equal(branchReads, 0);
  assert.deepEqual(children.retainedCalls, []);
  h.controls.dispose();
});

test('recent history projects only current-branch user and assistant plain text', async () => {
  const entries = deepFreeze([
    { type: 'custom_message', id: 'custom-1', message: { role: 'user', content: 'CUSTOM_SENTINEL' } },
    branchMessage('user-1', 'user', [{ type: 'text', text: 'visible user' }, { type: 'image', data: 'IMAGE_SENTINEL' }]),
    branchMessage('tool-1', 'toolResult', [{ type: 'text', text: 'TOOL_SENTINEL' }]),
    branchMessage('assistant-1', 'assistant', [
      { type: 'text', text: 'visible assistant' },
      { type: 'thinking', thinking: 'THINKING_SENTINEL' },
      { type: 'toolCall', name: 'tool', arguments: { path: '/SECRET/PATH' } },
    ]),
    { type: 'compaction', id: 'compaction-1', summary: 'SYSTEM_SENTINEL', systemMessage: { role: 'system', content: '/SYSTEM/PATH' } },
    branchMessage('user-2', 'user', 'second user'),
  ]);
  const before = JSON.stringify(entries);
  const h = harness({ branch: () => entries });
  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 20, cursor: null }));
  await until(() => h.historyResults().some(result => result.phase === 'completed'), 'history terminal');
  const result = h.historyResults().find(result => result.phase === 'completed');
  const page = result?.outcome.value as {
    scope: string;
    items: { id: string; role: string; text: string; truncated: boolean }[];
    omitted: number;
    truncated: boolean;
  };
  assert.equal(page.scope, 'current-session-branch');
  assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor', 'omitted', 'ownerEpoch', 'ownerSessionId', 'scope', 'truncated', 'version']);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['id', 'role', 'text', 'truncated']);
  assert.deepEqual(page.items, [
    { id: 'user-1', role: 'user', text: 'visible user', truncated: false },
    { id: 'assistant-1', role: 'assistant', text: 'visible assistant', truncated: false },
    { id: 'user-2', role: 'user', text: 'second user', truncated: false },
  ]);
  assert.equal(page.omitted, 1);
  assert.equal(page.truncated, true);
  const serialized = JSON.stringify(result);
  for (const sentinel of ['CUSTOM_SENTINEL', 'TOOL_SENTINEL', 'THINKING_SENTINEL', 'SYSTEM_SENTINEL', 'IMAGE_SENTINEL', '/SECRET/PATH', '/SYSTEM/PATH']) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  assert.equal(JSON.stringify(entries), before, 'the source branch is not mutated');
  h.controls.dispose();
});

test('history continuation does not count deferred items as omitted', async () => {
  const entries = [
    branchMessage('entry-1', 'user', 'one'),
    branchMessage('entry-2', 'assistant', 'two'),
    branchMessage('entry-3', 'user', 'three'),
  ];
  const h = harness({ branch: () => entries });
  let cursor: string | null = null;
  const pages: { text: string; omitted: number; truncated: boolean; nextCursor: string | null }[] = [];

  for (let index = 0; index < 3; index += 1) {
    const requestId = `continuation-${index}`;
    h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor }, { requestId }));
    await until(() => h.historyResults().some(result => result.requestId === requestId && result.phase === 'completed'), `continuation ${index}`);
    const page = h.historyResults().find(result => result.requestId === requestId && result.phase === 'completed')?.outcome.value as {
      items: { text: string }[]; omitted: number; truncated: boolean; nextCursor: string | null;
    };
    pages.push({ text: page.items[0].text, omitted: page.omitted, truncated: page.truncated, nextCursor: page.nextCursor });
    cursor = page.nextCursor;
  }

  assert.deepEqual(pages.map(page => page.text), ['one', 'two', 'three']);
  assert.deepEqual(pages.map(page => page.omitted), [0, 0, 0]);
  assert.deepEqual(pages.map(page => page.truncated), [false, false, false]);
  assert.ok(pages[0].nextCursor);
  assert.ok(pages[1].nextCursor);
  assert.equal(pages[2].nextCursor, null);
  h.controls.dispose();
});

test('history caps bound multibyte text, escaping, candidate count, and page bytes', async () => {
  const huge = '😀'.repeat(20_000);
  const entries = deepFreeze([
    ...Array.from({ length: 5 }, (_, index) => branchMessage(`old-${index}`, 'user', `old ${index}`)),
    branchMessage('huge', 'assistant', huge),
    ...Array.from({ length: 199 }, (_, index) => branchMessage(`tail-${index}`, 'user', `tail ${index}`)),
  ]);
  const h = harness({ branch: () => entries });
  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 20, cursor: null }));
  await until(() => h.historyResults().some(result => result.phase === 'completed'), 'bounded history');
  const result = h.historyResults().find(result => result.phase === 'completed');
  const page = result?.outcome.value as {
    items: { id: string; role: string; text: string; truncated: boolean }[];
    omitted: number;
    truncated: boolean;
  };
  assert.ok(page.items.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 64 * 1024);
  assert.ok(page.items.every(item => Buffer.byteLength(JSON.stringify(item), 'utf8') <= 16 * 1024));
  assert.ok(page.items.some(item => item.truncated));
  assert.ok(page.omitted >= 5);
  assert.equal(page.truncated, true);
  assert.equal(page.items[0]?.text.startsWith('😀'), true);
  h.controls.dispose();
});

test('the serialized history result stays within 64 KiB when every item is large', async () => {
  const entries = Array.from({ length: 20 }, (_, index) => branchMessage(`large-${index}`, 'user', `line-${index}\n${'x'.repeat(16 * 1024)}`));
  const h = harness({ branch: () => entries });
  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 20, cursor: null }, { requestId: 'large-page' }));
  await until(() => h.historyResults().some(result => result.requestId === 'large-page' && result.phase === 'completed'), 'large page');
  const result = h.historyResults().find(result => result.requestId === 'large-page' && result.phase === 'completed')!;
  const page = result.outcome.value as { items: unknown[]; omitted: number; truncated: boolean; nextCursor: string | null };
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 64 * 1024);
  assert.ok(page.items.length < 20);
  assert.ok(page.nextCursor);
  assert.equal(page.omitted, 0);
  assert.equal(page.truncated, true, 'the oversized item text was actually truncated');
  h.controls.dispose();
});

test('history cursors are opaque, owner/client scoped, expiring, and evictable', async () => {
  const entries = Array.from({ length: 25 }, (_, index) => branchMessage(`entry-${index}`, 'user', `text ${index}`));
  const time = clock();
  const h = harness({ branch: () => entries, time });
  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: null }, { requestId: 'cursor-first' }));
  await until(() => h.historyResults().some(result => result.requestId === 'cursor-first' && result.phase === 'completed'), 'first cursor');
  const first = h.historyResults().find(result => result.requestId === 'cursor-first' && result.phase === 'completed')?.outcome.value as { nextCursor: string; items: { text: string }[] };
  assert.match(first.nextCursor, /^[0-9a-f-]{36}$/);
  assert.equal(first.items[0].text, 'text 0');

  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: first.nextCursor }, { requestId: 'cursor-second' }));
  await until(() => h.historyResults().some(result => result.requestId === 'cursor-second' && result.phase === 'completed'), 'second cursor');
  const second = h.historyResults().find(result => result.requestId === 'cursor-second' && result.phase === 'completed')?.outcome.value as { items: { text: string }[] };
  assert.equal(second.items[0].text, 'text 1');

  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: '00000000-0000-4000-8000-000000000000' }, { requestId: 'cursor-forged' }));
  await until(() => h.historyResults().some(result => result.requestId === 'cursor-forged'), 'forged cursor');
  assert.equal(h.historyResults().find(result => result.requestId === 'cursor-forged')?.outcome.code, 'NOT_FOUND');

  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: first.nextCursor }, { requestId: 'cursor-foreign-client', clientId: 'client-2' }));
  await until(() => h.historyResults().some(result => result.requestId === 'cursor-foreign-client'), 'foreign client cursor');
  assert.equal(h.historyResults().find(result => result.requestId === 'cursor-foreign-client')?.outcome.code, 'POLICY_DENIED');

  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: first.nextCursor }, { requestId: 'cursor-foreign-epoch', ownerEpoch: 'epoch-2' }));
  await until(() => h.historyResults().some(result => result.requestId === 'cursor-foreign-epoch'), 'foreign epoch cursor');
  assert.equal(h.historyResults().find(result => result.requestId === 'cursor-foreign-epoch')?.outcome.code, 'STALE_OWNER');

  for (let index = 0; index < 17; index += 1) {
    h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: null }, { requestId: `cursor-evict-${index}` }));
    await until(() => h.historyResults().some(result => result.requestId === `cursor-evict-${index}` && result.phase === 'completed'), `cursor eviction ${index}`);
  }
  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: first.nextCursor }, { requestId: 'cursor-evicted' }));
  await until(() => h.historyResults().some(result => result.requestId === 'cursor-evicted'), 'evicted cursor');
  assert.equal(h.historyResults().find(result => result.requestId === 'cursor-evicted')?.outcome.code, 'NOT_FOUND');

  const expiry = harness({ branch: () => entries, time });
  expiry.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: null }, { requestId: 'cursor-expiry' }));
  await until(() => expiry.historyResults().some(result => result.requestId === 'cursor-expiry' && result.phase === 'completed'), 'expiry cursor');
  const expiryCursor = expiry.historyResults().find(result => result.requestId === 'cursor-expiry' && result.phase === 'completed')?.outcome.value as { nextCursor: string };
  time.advance(60_001);
  expiry.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: expiryCursor.nextCursor }, { requestId: 'cursor-expired' }));
  await until(() => expiry.historyResults().some(result => result.requestId === 'cursor-expired'), 'expired cursor');
  assert.equal(expiry.historyResults().find(result => result.requestId === 'cursor-expired')?.outcome.code, 'NOT_FOUND');
  expiry.controls.dispose();
  h.controls.dispose();
});

test('the cursor cache byte bound evicts an older large snapshot and reports truncation', async () => {
  const text = 'x'.repeat(16 * 1024);
  const entries = Array.from({ length: 40 }, (_, index) => branchMessage(`large-${index}`, 'user', text));
  const h = harness({ branch: () => entries });
  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: null }, { requestId: 'byte-cursor-first' }));
  await until(() => h.historyResults().some(result => result.requestId === 'byte-cursor-first' && result.phase === 'completed'), 'first large cursor');
  const first = h.historyResults().find(result => result.requestId === 'byte-cursor-first' && result.phase === 'completed')?.outcome.value as { nextCursor: string; truncated: boolean; omitted: number };
  assert.ok(first.nextCursor);
  assert.equal(first.truncated, true);
  assert.ok(first.omitted > 0);

  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: null }, { requestId: 'byte-cursor-second' }));
  await until(() => h.historyResults().some(result => result.requestId === 'byte-cursor-second' && result.phase === 'completed'), 'second large cursor');
  h.events.api.emit('optchat:history:request:v1', historyRequest({ limit: 1, cursor: first.nextCursor }, { requestId: 'byte-cursor-evicted' }));
  await until(() => h.historyResults().some(result => result.requestId === 'byte-cursor-evicted'), 'byte-evicted cursor');
  assert.equal(h.historyResults().find(result => result.requestId === 'byte-cursor-evicted')?.outcome.code, 'NOT_FOUND');
  h.controls.dispose();
});

test('selected run results distinguish unfinished runs and project retained assistant text only', async () => {
  const children = new FakeChildren();
  const running = run({ id: 'running-run', state: 'running', started: 100 });
  children.liveRuns.set(running.id, { info: running });
  const finalized = run({ id: 'final-run', state: 'failed', started: 200, report: 'REPORT_ERROR_SENTINEL' });
  children.history.records.set(finalized.id, finalized);
  const retained = deepFreeze([
    { role: 'user', content: 'USER_SENTINEL' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'THINKING_SENTINEL' },
      { type: 'toolCall', name: 'tool', arguments: { path: '/TOOL/PATH' } },
      { type: 'text', text: 'final assistant text' },
    ], errorMessage: 'RAW_ERROR_SENTINEL' },
  ]);
  children.retainedMessages.set(finalized.id, retained);
  const before = JSON.stringify({ retained, finalized });
  const h = harness({ children });

  h.events.api.emit('optchat:history:request:v1', resultRequest({ runId: running.id, expectedStartedAt: 100 }, { requestId: 'result-running' }));
  await until(() => h.historyResults().some(result => result.requestId === 'result-running' && result.phase === 'completed'), 'unfinished result');
  const unfinished = h.historyResults().find(result => result.requestId === 'result-running' && result.phase === 'completed')?.outcome.value as { state: string; ready: boolean; text: string };
  assert.deepEqual(unfinished, { version: 1, runId: 'running-run', state: 'running', ready: false, text: '', truncated: false });
  assert.deepEqual(Object.keys(unfinished).sort(), ['ready', 'runId', 'state', 'text', 'truncated', 'version']);
  assert.deepEqual(children.retainedCalls, []);

  h.events.api.emit('optchat:history:request:v1', resultRequest({ runId: finalized.id, expectedStartedAt: 200 }, { requestId: 'result-final' }));
  await until(() => h.historyResults().some(result => result.requestId === 'result-final' && result.phase === 'completed'), 'final result');
  const completed = h.historyResults().find(result => result.requestId === 'result-final' && result.phase === 'completed')?.outcome.value as { state: string; ready: boolean; text: string; truncated: boolean };
  assert.deepEqual(completed, { version: 1, runId: 'final-run', state: 'failed', ready: true, text: 'final assistant text', truncated: false });
  assert.deepEqual(Object.keys(completed).sort(), ['ready', 'runId', 'state', 'text', 'truncated', 'version']);
  const serialized = JSON.stringify(h.historyResults().find(result => result.requestId === 'result-final' && result.phase === 'completed'));
  for (const sentinel of ['REPORT_ERROR_SENTINEL', 'RAW_ERROR_SENTINEL', 'THINKING_SENTINEL', 'TOOL_SENTINEL', 'USER_SENTINEL', '/TOOL/PATH']) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  assert.equal(JSON.stringify({ retained, finalized }), before, 'retained messages and run metadata are not mutated');
  h.controls.dispose();
});

test('selected run result text is capped at 32 KiB on a Unicode boundary', async () => {
  const children = new FakeChildren();
  const large = run({ id: 'large-result', state: 'completed', started: 100 });
  children.history.records.set(large.id, large);
  children.retainedMessages.set(large.id, [{ role: 'assistant', content: [{ type: 'text', text: '😀'.repeat(20_000) }] }]);
  const h = harness({ children });
  h.events.api.emit('optchat:history:request:v1', resultRequest({ runId: large.id, expectedStartedAt: 100 }, { requestId: 'result-large' }));
  await until(() => h.historyResults().some(result => result.requestId === 'result-large' && result.phase === 'completed'), 'large result');
  const value = h.historyResults().find(result => result.requestId === 'result-large' && result.phase === 'completed')?.outcome.value as { text: string; truncated: boolean };
  assert.equal(value.truncated, true);
  assert.ok(Buffer.byteLength(value.text, 'utf8') <= 32 * 1024);
  assert.equal(value.text.includes('�'), false);
  h.controls.dispose();
});

test('selected run results reject stale generations and non-top-level records before retained reads', async () => {
  const children = new FakeChildren();
  const stale = run({ id: 'stale-run', state: 'completed', started: 100 });
  const nested = run({ id: 'nested-run', state: 'completed', started: 200, depth: 2 });
  const connected = run({ id: 'connected-run', state: 'completed', started: 300, connected: true });
  children.history.records.set(stale.id, stale);
  children.history.records.set(nested.id, nested);
  children.history.records.set(connected.id, connected);
  const h = harness({ children });

  h.events.api.emit('optchat:history:request:v1', resultRequest({ runId: stale.id, expectedStartedAt: 99 }, { requestId: 'result-stale' }));
  h.events.api.emit('optchat:history:request:v1', resultRequest({ runId: nested.id, expectedStartedAt: 200 }, { requestId: 'result-nested' }));
  h.events.api.emit('optchat:history:request:v1', resultRequest({ runId: connected.id, expectedStartedAt: 300 }, { requestId: 'result-connected' }));
  await until(() => h.historyResults().length === 3, 'run rejections');
  assert.deepEqual(h.historyResults().map(result => result.outcome.code), ['STALE_RUN', 'POLICY_DENIED', 'POLICY_DENIED']);
  assert.deepEqual(children.retainedCalls, []);
  h.controls.dispose();
});
