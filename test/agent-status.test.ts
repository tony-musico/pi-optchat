import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES_EVENT, PING_EVENT, STATUS_EVENT, createStatusPublisher, currentTool, projectStatus, statusCapabilities, statusKey, type StatusBus, type StatusLive, type StatusSource, type StatusTimer, type StatusV1 } from '../src/agent-status.ts';
import type { RunInfo, RunState } from '../src/runs.ts';

/** A run as OptChat records it. Only the fields a snapshot may use are set here. */
function run(overrides: Partial<RunInfo> & { id: string }): RunInfo {
  return {
    task: 'Do the thing.', cwd: '/tmp/work', model: 'fixture/fixture', thinking: 'off',
    parentSession: 'session-1', started: 1_000, depth: 1, state: 'running' as RunState, guidance: [],
    ...overrides,
  };
}

function source(runs: RunInfo[], live: Record<string, StatusLive> = {}): StatusSource {
  return { list: () => runs, live: id => live[id] };
}

function tools(entries: Record<string, { name: string; started: number }>): Map<string, { name: string; started: number }> {
  return new Map(Object.entries(entries));
}

/** A bus that records what was published, like Pi's. */
function bus(onEmit?: (channel: string) => void) {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: { channel: string; data: unknown }[] = [];
  const api: StatusBus = {
    emit(channel, data) { emitted.push({ channel, data }); onEmit?.(channel); for (const handler of [...(handlers.get(channel) ?? [])]) handler(data); },
    on(channel, handler) { const set = handlers.get(channel) ?? new Set(); set.add(handler); handlers.set(channel, set); return () => { set.delete(handler); }; },
  };
  return { api, emitted, count: () => handlers.size };
}

/** A clock and a timer the test drives by hand. */
function clock() {
  let now = 10_000;
  const tasks = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const timer: StatusTimer = {
    set(run, delayMs) { const id = next++; tasks.set(id, { at: now + delayMs, run }); return id; },
    clear(handle) { tasks.delete(handle as number); },
  };
  return {
    now: () => now,
    timer,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        tasks.delete(due[0]);
        due[1].run();
      }
      now = until;
    },
    pending: () => tasks.size,
  };
}

const statuses = (emitted: { channel: string; data: unknown }[]) => emitted.filter(e => e.channel === STATUS_EVENT).map(e => e.data as StatusV1);

test('an empty fleet has no agents and no counts', () => {
  const status = projectStatus(source([]), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(status);
  assert.equal(status.version, 1);
  assert.equal(status.profile, 'work');
  assert.equal(status.ownerSessionId, 'session-1');
  assert.equal(status.sampledAt, 5_000);
  assert.deepEqual(status.counts, { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 });
  assert.deepEqual(status.agents, []);
});

test('running, waiting, stopping, paused and handing-off runs are counted apart, and finished runs are left out', () => {
  const runs = [
    run({ id: 'a', state: 'running' }),
    run({ id: 'b', state: 'waiting' }),
    run({ id: 'c', state: 'stopping' }),
    run({ id: 'd', state: 'paused' }),
    run({ id: 'e', state: 'completed', ended: 2_000, handoff: { reason: 'complete' } }),
    run({ id: 'f', state: 'completed', ended: 2_000, handoff: { reason: 'complete', delivered: true } }),
    run({ id: 'g', state: 'failed', ended: 2_000 }),
    run({ id: 'h', state: 'interrupted', ended: 2_000 }),
  ];
  const status = projectStatus(source(runs), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(status);
  assert.deepEqual(status.counts, { active: 3, paused: 1, handingOff: 1, total: 5, omitted: 0 });
  assert.deepEqual(status.agents.map(agent => agent.runId), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(status.agents[4].handingOff, true);
  assert.equal(status.agents[0].handingOff, false);
});

test('the cap keeps the first runs in order and counts the ones it left out', () => {
  const runs = Array.from({ length: 70 }, (_, index) => run({ id: `run-${String(index).padStart(3, '0')}`, state: 'running' }));
  const status = projectStatus(source(runs), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(status);
  assert.equal(status.agents.length, 64);
  assert.equal(status.counts.total, 70);
  assert.equal(status.counts.omitted, 6);
  assert.equal(status.agents[0].runId, 'run-000');
  assert.equal(status.agents[63].runId, 'run-063');
});

test('a parent may be missing while its child is not', () => {
  const runs = [run({ id: 'parent', state: 'running' }), run({ id: 'child', parentId: 'parent', depth: 2, state: 'running' })];
  const status = projectStatus(source(runs), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(status);
  assert.equal(status.agents[1].parentId, 'parent');
  assert.equal(status.agents[1].depth, 2);
  const capped = projectStatus(source(runs), { profile: 'work', ownerSessionId: 'session-1', now: 5_000, maxAgents: 1 });
  assert.ok(capped);
  assert.equal(capped.agents.length, 1);
  assert.equal(capped.counts.omitted, 1);
});

test('the current tool is the one that started last, and a tie is broken the same way every time', () => {
  const live: StatusLive = { updated: 7, tools: tools({ 'call-b': { name: 'read', started: 50 }, 'call-a': { name: 'bash', started: 50 }, 'call-c': { name: 'edit', started: 90 } }) };
  assert.equal(currentTool(live), 'edit');
  const tie: StatusLive = { updated: 7, tools: tools({ 'call-b': { name: 'read', started: 50 }, 'call-a': { name: 'bash', started: 50 } }) };
  assert.equal(currentTool(tie), 'bash');
  assert.equal(currentTool(tie), currentTool({ updated: 7, tools: tools({ 'call-b': { name: 'read', started: 50 }, 'call-a': { name: 'bash', started: 50 } }) }));
  assert.equal(currentTool(undefined), null);
  assert.equal(currentTool({ updated: 7, tools: tools({}) }), null);
});

test('a run that is not live has no tool, and its last activity is when it ended', () => {
  const runs = [run({ id: 'a', state: 'paused', started: 1_000 })];
  const status = projectStatus(source(runs), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(status);
  assert.equal(status.agents[0].currentTool, null);
  assert.equal(status.agents[0].lastActivityAt, null);
  const ended = projectStatus(source([run({ id: 'a', state: 'completed', ended: 4_000, handoff: { reason: 'complete' } })]), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(ended);
  assert.equal(ended.agents[0].lastActivityAt, 4_000);
  const live = projectStatus(source(runs, { a: { updated: 4_200, tools: tools({ 'x': { name: 'bash', started: 1 } }) } }), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(live);
  assert.equal(live.agents[0].currentTool, 'bash');
  assert.equal(live.agents[0].lastActivityAt, 4_200);
});

test('a model or a tool that is not an identifier is left out rather than published', () => {
  const runs = [run({ id: 'a', state: 'running', model: 'Read the secret plan for the merger' })];
  const status = projectStatus(source(runs, { a: { updated: 1, tools: tools({ x: { name: 'bash --rm -rf /', started: 1 } }) } }), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(status);
  assert.equal(status.agents[0].model, null);
  assert.equal(status.agents[0].currentTool, null);
  const long = projectStatus(source([run({ id: 'a', state: 'running', model: `provider/${'x'.repeat(300)}` })]), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(long);
  assert.equal(long.agents[0].model, null);
  const good = projectStatus(source([run({ id: 'a', state: 'running', model: 'openai-codex/gpt-6-sol' })]), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(good);
  assert.equal(good.agents[0].model, 'openai-codex/gpt-6-sol');
});

test('an identity that cannot be published stops the snapshot instead of dropping a row', () => {
  const runs = [run({ id: 'a', state: 'running' }), run({ id: 'not a run id', state: 'running' })];
  assert.equal(projectStatus(source(runs), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 }), undefined);
  assert.equal(projectStatus(source([run({ id: 'a', state: 'running' })]), { profile: 'Work Space', ownerSessionId: 'session-1', now: 5_000 }), undefined);
  assert.equal(projectStatus(source([run({ id: 'a', state: 'running' })]), { profile: 'work', ownerSessionId: 'session 1', now: 5_000 }), undefined);
  assert.equal(projectStatus(source([run({ id: 'a', state: 'running' })]), { profile: 'work', ownerSessionId: 'session-1', now: Number.NaN }), undefined);
});

test('nothing but the allowlist reaches the payload', () => {
  const secret = 'SECRET-TASK-TEXT';
  const runs = [run({
    id: 'a', state: 'running', task: secret, title: secret, cwd: `/home/tony/${secret}`, report: secret,
    sessionFile: `/home/tony/${secret}/session.jsonl`, guidance: [{ text: secret, date: 1, state: 'queued' }],
  })];
  const live: StatusLive = { updated: 7, tools: tools({ 'call-a': { name: 'bash', started: 5 } }) } as StatusLive;
  const status = projectStatus(source(runs, { a: live }), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(status);
  const text = JSON.stringify(status);
  assert.doesNotMatch(text, /SECRET-TASK-TEXT/);
  assert.deepEqual(Object.keys(status), ['version', 'profile', 'ownerSessionId', 'sampledAt', 'counts', 'agents']);
  assert.deepEqual(Object.keys(status.agents[0]), ['runId', 'state', 'handingOff', 'model', 'elapsed', 'currentTool', 'lastActivityAt', 'parentId', 'depth']);
  assert.deepEqual(Object.keys(status.counts), ['active', 'paused', 'handingOff', 'total', 'omitted']);
});

test('the projection does not touch the runs it reads', () => {
  const runs = [run({ id: 'a', state: 'running', title: 'A title' })];
  const live: StatusLive = { updated: 7, tools: tools({ 'call-a': { name: 'bash', started: 5 } }) };
  const before = JSON.stringify(runs);
  const status = projectStatus(source(runs, { a: live }), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  assert.ok(status);
  status.agents[0].runId = 'changed';
  status.agents.push({ runId: 'x' } as never);
  assert.equal(JSON.stringify(runs), before, 'the runs are untouched');
  assert.equal(live.tools.size, 1, 'the live tools are untouched');
});

test('the same fleet at another time is the same key, and a new state is not', () => {
  const one = projectStatus(source([run({ id: 'a', state: 'running' })]), { profile: 'work', ownerSessionId: 'session-1', now: 5_000 });
  const two = projectStatus(source([run({ id: 'a', state: 'running' })]), { profile: 'work', ownerSessionId: 'session-1', now: 9_000 });
  const three = projectStatus(source([run({ id: 'a', state: 'waiting' })]), { profile: 'work', ownerSessionId: 'session-1', now: 9_000 });
  assert.ok(one && two && three);
  assert.equal(statusKey(one), statusKey(two), 'time alone is not a change');
  assert.notEqual(statusKey(one), statusKey(three), 'a new state is a change');
});

test('capabilities say what the owner offers, and nothing else', () => {
  const capabilities = statusCapabilities('work', 'session-1');
  assert.ok(capabilities);
  assert.equal(capabilities.version, 1);
  assert.equal(capabilities.profile, 'work');
  assert.equal(capabilities.ownerSessionId, 'session-1');
  assert.deepEqual(capabilities.events, { status: STATUS_EVENT, capabilities: CAPABILITIES_EVENT, ping: PING_EVENT });
  assert.equal(capabilities.status.scope, 'profile-owner');
  assert.equal(capabilities.status.inProcessOnly, true);
  assert.equal(capabilities.status.observationOnly, true);
  assert.equal(capabilities.status.maxAgents, 64);
  assert.equal(capabilities.status.minIntervalMs, 250);
  assert.equal(capabilities.status.titles, false);
  assert.deepEqual([...capabilities.status.fields], ['runId', 'state', 'handingOff', 'model', 'elapsed', 'currentTool', 'lastActivityAt', 'parentId', 'depth']);
  assert.equal(statusCapabilities('Work', 'session-1'), undefined);
});

test('the publisher advertises before its first status, with the whole fleet', () => {
  const events = bus();
  const time = clock();
  const runs = [run({ id: 'a', state: 'running' })];
  const publisher = createStatusPublisher({ bus: events.api, source: source(runs), profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: time.timer });
  try {
    assert.deepEqual(events.emitted.map(e => e.channel), [CAPABILITIES_EVENT, STATUS_EVENT]);
    assert.deepEqual(statuses(events.emitted)[0].agents.map(a => a.runId), ['a']);
  } finally { publisher.dispose(); }
});

test('many changes in one window publish once, with the latest state', () => {
  const events = bus();
  const time = clock();
  const runs = [run({ id: 'a', state: 'running' })];
  let changed = () => {};
  const publisher = createStatusPublisher({ bus: events.api, source: source(runs), profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: time.timer, subscribe: listener => { changed = listener; return () => { changed = () => {}; }; } });
  try {
    assert.equal(statuses(events.emitted).length, 1, 'the first status is published at once');
    runs[0].state = 'waiting';
    changed(); changed(); changed();
    time.advance(249);
    assert.equal(statuses(events.emitted).length, 1, 'nothing is published before the window ends');
    time.advance(1);
    assert.equal(statuses(events.emitted).length, 2, 'the window publishes once');
    assert.equal((statuses(events.emitted)[1].agents[0]).state, 'waiting');
    runs[0].state = 'paused';
    changed();
    time.advance(250);
    assert.equal(statuses(events.emitted).length, 3);
  } finally { publisher.dispose(); }
});

test('a busy fleet cannot postpone its own publication', () => {
  const events = bus();
  const time = clock();
  let changed = () => {};
  const runs = [run({ id: 'a', state: 'running' })];
  const publisher = createStatusPublisher({ bus: events.api, source: source(runs), profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: time.timer, subscribe: listener => { changed = listener; return () => { changed = () => {}; }; } });
  try {
    for (let i = 0; i < 20; i++) { runs[0].state = i % 2 ? 'running' : 'waiting'; changed(); time.advance(10); }
    runs[0].state = 'waiting';
    time.advance(50);
    assert.equal(statuses(events.emitted).length, 2, 'the window ends on time, however busy the fleet is');
    assert.equal(time.pending(), 0, 'no work is left pending');
  } finally { publisher.dispose(); }
});

test('an unchanged fleet is not published again, and a ping is', () => {
  const events = bus();
  const time = clock();
  let changed = () => {};
  const publisher = createStatusPublisher({ bus: events.api, source: source([run({ id: 'a', state: 'running' })]), profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: time.timer, subscribe: listener => { changed = listener; return () => { changed = () => {}; }; } });
  try {
    changed();
    time.advance(250);
    assert.equal(statuses(events.emitted).length, 1, 'nothing changed, so nothing is published');
    events.api.emit(PING_EVENT, { anything: 'ignored' });
    time.advance(250);
    const published = events.emitted.filter(e => e.channel === CAPABILITIES_EVENT || e.channel === STATUS_EVENT).map(e => e.channel);
    assert.deepEqual(published, [CAPABILITIES_EVENT, STATUS_EVENT, CAPABILITIES_EVENT, STATUS_EVENT], 'a ping replays capabilities and status');
  } finally { publisher.dispose(); }
});

test('a change that arrives while publishing is published afterwards', () => {
  const time = clock();
  const runs = [run({ id: 'a', state: 'running' })];
  let changed = () => {};
  // The fleet changes while the status is being published, as a streaming agent would.
  const events = bus(() => { runs[0].state = 'waiting'; changed(); });
  const publisher = createStatusPublisher({ bus: events.api, source: source(runs), profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: time.timer, subscribe: listener => { changed = listener; return () => { changed = () => {}; }; } });
  try {
    assert.equal(statuses(events.emitted).length, 1, 'the first status is published at once');
    time.advance(250);
    assert.equal(statuses(events.emitted).length, 2, 'the change during the publication is kept');
    assert.equal(statuses(events.emitted)[1].agents[0].state, 'waiting', 'and the new state is what is published');
  } finally { publisher.dispose(); }
});

test('disposal stops everything, and a scheduled callback does nothing when it fires', () => {
  const events = bus();
  const time = clock();
  let changed = () => {};
  const publisher = createStatusPublisher({ bus: events.api, source: source([run({ id: 'a', state: 'running' })]), profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: time.timer, subscribe: listener => { changed = listener; return () => { changed = () => {}; }; } });
  changed();
  assert.equal(time.pending(), 1);
  publisher.dispose();
  publisher.dispose();
  assert.equal(time.pending(), 0, 'the timer is cancelled');
  time.advance(1_000);
  assert.equal(statuses(events.emitted).length, 1, 'only the first status was published');
  changed();
  time.advance(1_000);
  assert.equal(statuses(events.emitted).length, 1, 'a disposed publisher stays quiet');
});

test('a failure is reported by what failed, never by what it said', () => {
  const secret = 'SECRET-TASK-TEXT';
  const warnings: string[] = [];
  const time = clock();
  const failing: StatusSource = {
    list() { throw new Error(`could not read the run ${secret}`); },
    live() { return undefined; },
  };
  const publisher = createStatusPublisher({ bus: bus().api, source: failing, profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: time.timer, warn: message => warnings.push(message) });
  try {
    assert.deepEqual(warnings, ['OptChat could not publish agent status: the agents could not be read.']);
    assert.doesNotMatch(warnings.join(' '), /SECRET-TASK-TEXT/, 'the task text of the failure never reaches a warning');
  } finally { publisher.dispose(); }
});

test('a bus that fails with task text never puts it in a warning', () => {
  const secret = 'SECRET-TASK-TEXT';
  const warnings: string[] = [];
  const time = clock();
  const broken: StatusBus = {
    emit() { throw new Error(`the bus refused ${secret}`); },
    on(_channel, handler) { return () => { handler(undefined); }; },
  };
  const publisher = createStatusPublisher({ bus: broken, source: source([run({ id: 'a', state: 'running' })]), profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: time.timer, warn: message => warnings.push(message) });
  try {
    assert.deepEqual(warnings, ['OptChat could not publish agent status: the event bus refused the message.']);
    assert.doesNotMatch(warnings.join(' '), /SECRET-TASK-TEXT/, 'the bus error never reaches a warning');
  } finally { publisher.dispose(); }
});

test('a timer that fails with task text never puts it in a warning', () => {
  const secret = 'SECRET-TASK-TEXT';
  const warnings: string[] = [];
  const time = clock();
  const brokenTimer: StatusTimer = { set() { throw new Error(`the timer failed ${secret}`); }, clear() {} };
  let changed = () => {};
  const publisher = createStatusPublisher({ bus: bus().api, source: source([run({ id: 'a', state: 'running' })]), profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: brokenTimer, warn: message => warnings.push(message), subscribe: listener => { changed = listener; return () => { changed = () => {}; }; } });
  try {
    changed();
    assert.deepEqual(warnings, ['OptChat could not publish agent status: the status could not be scheduled.']);
    assert.doesNotMatch(warnings.join(' '), /SECRET-TASK-TEXT/, 'the timer error never reaches a warning');
  } finally { publisher.dispose(); }
});

test('a host that changes what it got cannot change the runs', () => {
  const events = bus();
  const time = clock();
  const runs = [run({ id: 'a', state: 'running' })];
  const publisher = createStatusPublisher({ bus: events.api, source: source(runs), profile: 'work', ownerSessionId: 'session-1', now: time.now, timer: time.timer });
  try {
    const status = statuses(events.emitted)[0];
    status.agents[0].runId = 'hijacked';
    status.counts.total = 99;
    assert.equal(runs[0].id, 'a');
    assert.equal(runs[0].state, 'running');
  } finally { publisher.dispose(); }
});
