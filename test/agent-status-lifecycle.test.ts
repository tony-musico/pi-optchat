import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, createEventBus, DefaultResourceLoader, type EventBus, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { CAPABILITIES_EVENT, PING_EVENT, STATUS_EVENT, type StatusV1 } from '../src/agent-status.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const root = mkdtempSync(join(tmpdir(), 'oc-status-'));
const oldHome = process.env.OPTCHAT_HOME;
process.env.OPTCHAT_HOME = join(root, 'home');
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
after(() => {
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  removeDir(root);
});
const fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
createProfile('work');
saveConfig(profilePath('work'), { ...loadConfig(profilePath('work')), compactor: fixture, subagent: fixture });

const until = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), what);
};

/** A Pi session with OptChat in it, on a bus the test can watch. */
async function start(dir: string, options: { bound?: string; mode?: 'tui' | 'print' | 'rpc'; bus?: EventBus; connect?: string } = {}) {
  mkdirSync(dir, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const last = context.messages.at(-1), text = textContent(last && 'content' in last ? last.content : '');
      const child = text.includes('\n\nYour task:\n');
      const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'ok' }],
        timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
      if (!child && text.endsWith('Spawn one.')) {
        reply.content = [{ type: 'toolCall', id: 'spawn-1', name: 'spawn', arguments: { tasks: [{ task: 'Work until stopped.' }] } }]; reply.stopReason = 'toolUse';
      }
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (child) {
          stream.push({ type: 'start', partial: reply });
          await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        }
        if (options?.signal?.aborted) { reply.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: reply }); }
        else stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply });
        stream.end();
      })();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const bus = options.bus ?? createEventBus();
  const published: { channel: string; data: unknown }[] = [];
  bus.on(CAPABILITIES_EVENT, data => { published.push({ channel: CAPABILITIES_EVENT, data }); });
  bus.on(STATUS_EVENT, data => { published.push({ channel: STATUS_EVENT, data }); });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, eventBus: bus,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  if (options.bound !== undefined) manager.appendCustomEntry('optchat.profile', { name: options.bound });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'spawn'] });
  if (options.connect !== undefined) session.extensionRunner.setFlagValue('optchat-connect', options.connect);
  const notes: string[] = [], errors: string[] = [];
  await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: text => { notes.push(text); } }, mode: options.mode ?? 'tui', onError: error => { errors.push(error.error); } });
  const statuses = () => published.filter(event => event.channel === STATUS_EVENT).map(event => event.data as StatusV1);
  const capabilities = () => published.filter(event => event.channel === CAPABILITIES_EVENT);
  const close = async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };
  return { session, manager, bus, published, notes, errors, statuses, capabilities, close };
}

test('the owner advertises what it offers before its first status', async () => {
  const pi = await start(join(root, 'owner'), { bound: 'work' });
  try {
    assert.deepEqual(pi.published.map(event => event.channel), [CAPABILITIES_EVENT, STATUS_EVENT], 'capabilities come first, and the status follows');
    const status = pi.statuses()[0];
    assert.equal(status.version, 1);
    assert.equal(status.profile, 'work');
    assert.equal(status.ownerSessionId, pi.manager.getSessionId());
    assert.deepEqual(status.counts, { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 });
    assert.deepEqual(status.agents, [], 'the fleet is empty, and the status says so');
    const capabilities = pi.capabilities()[0].data as { status: { scope: string; observationOnly: boolean; inProcessOnly: boolean; titles: boolean } };
    assert.equal(capabilities.status.scope, 'profile-owner');
    assert.equal(capabilities.status.observationOnly, true);
    assert.equal(capabilities.status.inProcessOnly, true);
    assert.equal(capabilities.status.titles, false);
  } finally { await pi.close(); }
});

test('a background agent shows up in the next status', async () => {
  const pi = await start(join(root, 'spawner'), { bound: 'work' });
  try {
    await pi.session.prompt('Spawn one.');
    await until(() => pi.statuses().some(status => status.counts.total === 1), 'the child is in a status');
    const status = pi.statuses().find(candidate => candidate.counts.total === 1)!;
    assert.equal(status.agents.length, 1);
    assert.equal(status.agents[0].state, 'running');
    assert.equal(status.agents[0].model, 'fixture/fixture');
    assert.match(status.agents[0].runId, /^[A-Za-z0-9-]+$/);
    assert.equal(status.agents[0].parentId, null);
    assert.equal(status.agents[0].depth, 1);
    assert.equal(status.counts.active, 1);
    const text = JSON.stringify(status);
    assert.doesNotMatch(text, /Work until stopped/, 'the task never reaches the payload');
  } finally { await pi.close(); }
});

test('a ping asks for the status again, and the same owner starting again only replays it', async () => {
  const pi = await start(join(root, 'pinger'), { bound: 'work' });
  try {
    const before = pi.published.length;
    pi.bus.emit(PING_EVENT, { ignored: true });
    await until(() => pi.published.length >= before + 2, 'the ping is answered');
    assert.deepEqual(pi.published.slice(before).map(event => event.channel), [CAPABILITIES_EVENT, STATUS_EVENT], 'a ping replays capabilities and status');

    const afterPing = pi.published.length;
    // The same owner, the same session: Pi binds extensions twice, and the status must not start a second publisher.
    await pi.session.extensionRunner.emit({ type: 'session_start', reason: 'resume' });
    await until(() => pi.published.length >= afterPing + 2, 'the owner replays its status');
    assert.deepEqual(pi.published.slice(afterPing).map(event => event.channel), [CAPABILITIES_EVENT, STATUS_EVENT], 'one replay, not a second publisher');
  } finally { await pi.close(); }
});

test('nothing is published after the owner shuts down', async () => {
  const pi = await start(join(root, 'closing'), { bound: 'work' });
  await pi.close();
  const before = pi.published.length;
  pi.bus.emit(PING_EVENT, {});
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(pi.published.length, before, 'a closed owner publishes nothing');
});

test('a host that arrives after the first publication gets the status when it pings', async () => {
  const pi = await start(join(root, 'late'), { bound: 'work' });
  try {
    assert.equal(pi.statuses().length, 1, 'the owner published before the late host arrived');
    const late: { channel: string; data: unknown }[] = [];
    pi.bus.on(CAPABILITIES_EVENT, data => { late.push({ channel: CAPABILITIES_EVENT, data }); });
    pi.bus.on(STATUS_EVENT, data => { late.push({ channel: STATUS_EVENT, data }); });
    assert.equal(late.length, 0, 'the late host has missed the first publication and has nothing');
    pi.bus.emit(PING_EVENT, { late: true });
    await until(() => late.length >= 2, 'the ping is answered');
    assert.deepEqual(late.map(event => event.channel), [CAPABILITIES_EVENT, STATUS_EVENT], 'the replay comes with capabilities first');
    const status = late[1].data as StatusV1;
    assert.equal(status.version, 1);
    assert.equal(status.profile, 'work');
    assert.equal(status.ownerSessionId, pi.manager.getSessionId());
  } finally { await pi.close(); }
});

test('a failure reaches the screen as a fixed line, never as the text that failed', async () => {
  const secret = 'SECRET-TASK-TEXT';
  const real = createEventBus();
  const failing: EventBus = {
    emit(channel, data) { if (channel === STATUS_EVENT) throw new Error(`the bus refused ${secret}`); real.emit(channel, data); },
    on(channel, handler) { return real.on(channel, handler); },
  };
  const pi = await start(join(root, 'failing-bus'), { bound: 'work', bus: failing });
  try {
    assert.ok(pi.notes.some(note => note.includes('could not publish agent status')), 'the owner says that it could not publish');
    assert.ok(!pi.notes.some(note => note.includes(secret)), 'and the text that failed never reaches the screen');
  } finally { await pi.close(); }
});

test('a session that does not own a profile publishes nothing', async () => {
  const pi = await start(join(root, 'plain'), { mode: 'rpc' });
  try {
    assert.deepEqual(pi.published, [], 'a plain Pi session has no owner and no status');
    pi.bus.emit(PING_EVENT, {});
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(pi.published, [], 'and it does not answer a ping either');
  } finally { await pi.close(); }
});

test('a profile that fails to open publishes nothing', async () => {
  const pi = await start(join(root, 'failed'), { mode: 'rpc', bound: 'ghost' });
  try {
    assert.equal(pi.errors.length, 1, 'the failed profile is reported');
    assert.deepEqual(pi.published, [], 'a profile that never opened has no status');
  } finally { await pi.close(); }
});

test('a session that joins another Pi publishes nothing of its own', async () => {
  const bus = createEventBus();
  const owner = await start(join(root, 'joining-owner'), { bound: 'work', bus });
  try {
    const joined = await start(join(root, 'joiner'), { mode: 'print', bus, bound: 'work', connect: 'join' });
    try {
      assert.deepEqual(joined.errors, [], 'the joined session starts without an error');
      await new Promise(resolve => setTimeout(resolve, 300));
      for (const event of owner.published) if (event.channel === STATUS_EVENT) {
        assert.equal((event.data as StatusV1).ownerSessionId, owner.manager.getSessionId(), 'only the owner publishes a status');
      }
    } finally { await joined.close(); }
  } finally { await owner.close(); }
});
