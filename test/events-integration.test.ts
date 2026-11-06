import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, createEventBus, DefaultResourceLoader, type EventBus, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { CAPABILITIES_EVENT, STATUS_EVENT, type StatusCapabilitiesV1 } from '../src/agent-status.ts';
import {
  AGENT_REQUEST_EVENT,
  AGENT_RESULT_EVENT,
  ATTENTION_EVENT,
  CONVERSATION_REQUEST_EVENT,
  CONVERSATION_RESULT_EVENT,
  HISTORY_REQUEST_EVENT,
  HISTORY_RESULT_EVENT,
  MAIN_PING_EVENT,
  MAIN_STATUS_EVENT,
  OUTPUT_EVENT,
  OUTPUT_SUBSCRIBE_EVENT,
  OWNER_EVENT,
  type AttentionEventV1,
  type EventRequestResultV1,
  type MainStatusV1,
  type OutputEventV1,
  type OwnerEventV1,
} from '../src/events-contract.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { result } from '../src/core/tools.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const root = mkdtempSync(join(tmpdir(), 'oc-events-'));
const oldHome = process.env.OPTCHAT_HOME;
process.env.OPTCHAT_HOME = join(root, 'home');
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
after(() => {
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  removeDir(root);
});
const fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
for (const name of ['work', 'delta', 'tool', 'errors', 'abort', 'content-off', 'late', 'ping', 'control', 'history', 'history-off']) {
  createProfile(name);
  saveConfig(profilePath(name), { ...loadConfig(profilePath(name)), compactor: fixture, subagent: fixture });
}

const until = async (predicate: () => boolean, what: string) => {
  for (let index = 0; index < 1000 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), what);
};

const assistant = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'fixture',
  usage: emptyUsage(), stopReason, timestamp: 1,
});

async function start(dir: string, options: {
  bound?: string;
  mode?: 'tui' | 'print' | 'rpc' | 'json';
  bus?: EventBus;
  content?: boolean;
  control?: boolean;
  connect?: string;
  select?: (title: string, choices: string[]) => Promise<string | undefined>;
  failOwnerNotice?: boolean;
} = {}) {
  mkdirSync(dir, { recursive: true });
  let releaseDelta = () => {}, releaseDone = () => {}, deltaStarted = () => {}, abortStarted = () => {};
  const deltaReady = new Promise<void>(resolve => { releaseDelta = resolve; });
  const deltaDone = new Promise<void>(resolve => { releaseDone = resolve; });
  const deltaSeen = new Promise<void>(resolve => { deltaStarted = resolve; });
  const abortSeen = new Promise<void>(resolve => { abortStarted = resolve; });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, streamOptions) {
      const prompt = context.messages.map(message => 'content' in message ? textContent(message.content) : '').join('\n');
      const hadTool = context.messages.some(message => message.role === 'toolResult');
      const stream = createAssistantMessageEventStream();
      if (prompt.includes('please use the tool') && !hadTool) {
        const message = assistant([{ type: 'toolCall', id: 'call-slow', name: 'slow_tool', arguments: {} }], 'toolUse');
        void (async () => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'toolUse', message }); stream.end(); })();
        return stream;
      }
      if (prompt.includes('Error')) {
        const message = { ...assistant([{ type: 'text', text: 'failed safely' }], 'error'), errorMessage: 'SECRET-PROVIDER-ERROR' };
        void (async () => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); })();
        return stream;
      }
      if (prompt.includes('Abort')) {
        const message = assistant([{ type: 'text', text: 'aborted safely' }], 'aborted');
        void (async () => {
          stream.push({ type: 'start', partial: message });
          abortStarted();
          await new Promise<void>(resolve => streamOptions?.signal?.addEventListener('abort', () => resolve(), { once: true }));
          stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end();
        })();
        return stream;
      }
      if (prompt.includes('Delta')) {
        const message = assistant([{ type: 'text', text: 'hello' }]);
        void (async () => {
          stream.push({ type: 'start', partial: message });
          deltaStarted();
          await deltaReady;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'hello', partial: message });
          await deltaDone;
          stream.push({ type: 'done', reason: 'stop', message }); stream.end();
        })();
        return stream;
      }
      const message = assistant([{ type: 'text', text: 'ok' }]);
      void (async () => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); })();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const bus = options.bus ?? createEventBus();
  const published: { channel: string; data: unknown }[] = [];
  for (const channel of [CAPABILITIES_EVENT, STATUS_EVENT, OWNER_EVENT, MAIN_STATUS_EVENT, ATTENTION_EVENT, OUTPUT_EVENT, CONVERSATION_RESULT_EVENT, AGENT_RESULT_EVENT, HISTORY_RESULT_EVENT]) {
    bus.on(channel, data => { published.push({ channel, data }); });
  }
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, eventBus: bus,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  if (options.bound !== undefined) manager.appendCustomEntry('optchat.profile', { name: options.bound });
  const slowTool = {
    name: 'slow_tool', label: 'Slow tool', description: 'Wait long enough for an owner snapshot.',
    parameters: Type.Object({}),
    async execute() { await new Promise(resolve => setTimeout(resolve, 350)); return result('tool done'); },
  };
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'spawn', 'slow_tool'], customTools: [slowTool] });
  if (options.content === true) session.extensionRunner.setFlagValue('optchat-events-content', true);
  if (options.control === true) session.extensionRunner.setFlagValue('optchat-events-control', true);
  if (options.connect !== undefined) session.extensionRunner.setFlagValue('optchat-connect', options.connect);
  const notes: string[] = [], errors: string[] = [];
  await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: text => {
    notes.push(text);
    if (options.failOwnerNotice && text.startsWith('OptChat') && text.includes(' · ')) throw new Error('SECRET-OWNER-NOTICE-FAILURE');
  },
    select: async (title, choices) => options.select ? options.select(title, choices) : undefined }, mode: options.mode ?? 'tui', onError: error => { errors.push(error.error); } });
  const events = (channel: string) => published.filter(event => event.channel === channel).map(event => event.data);
  const capability = () => events(CAPABILITIES_EVENT)[0] as StatusCapabilitiesV1 | undefined;
  const ownerEpoch = () => capability()?.integrations?.ownerEpoch;
  const close = async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };
  return {
    session, manager, bus, published, notes, errors, events, capability, ownerEpoch, close,
    releaseDelta, releaseDone, deltaSeen, abortSeen,
  };
}

const request = (ownerEpoch: string, operation: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
  version: 1, clientId: 'bridge-1', requestId: 'request-1', ownerSessionId: 'session-1',
  ownerEpoch, operation, payload, ...overrides,
});

type BridgeOwner = { ownerSessionId: string; ownerEpoch: string };
type BridgeResult = {
  version: number;
  clientId: string;
  requestId: string;
  ownerSessionId: string;
  ownerEpoch: string;
  phase: 'rejected' | 'accepted' | 'completed';
};

function applyDocumentedBridgeResult(result: BridgeResult, owner: BridgeOwner | undefined, pending: Set<string>): void {
  if (result.version !== 1 || result.clientId !== 'bridge-1' || !pending.has(result.requestId)
    || !owner || result.ownerSessionId !== owner.ownerSessionId || result.ownerEpoch !== owner.ownerEpoch) return;
  if (result.phase === 'accepted') return;
  if (result.phase !== 'completed' && result.phase !== 'rejected') return;
  pending.delete(result.requestId);
}

test('the real owner advertises integrations before status, then publishes owner and main snapshots', async () => {
  const pi = await start(join(root, 'owner-order'), { bound: 'work' });
  try {
    const ownerChannels = pi.published.map(event => event.channel);
    assert.deepEqual(ownerChannels.slice(0, 4), [CAPABILITIES_EVENT, STATUS_EVENT, OWNER_EVENT, MAIN_STATUS_EVENT]);
    const capability = pi.capability();
    assert.ok(capability);
    assert.equal(capability.status.observationOnly, true);
    assert.equal(capability.integrations?.content.enabled, false);
    assert.equal(capability.integrations?.control.enabled, false);
    const owner = pi.events(OWNER_EVENT)[0] as OwnerEventV1;
    assert.equal(owner.kind, 'ready');
    assert.equal(owner.ownerSessionId, pi.manager.getSessionId());
    const main = pi.events(MAIN_STATUS_EVENT)[0] as MainStatusV1;
    assert.equal(main.phase, 'idle');
    assert.equal(main.queueDepth, null);
    assert.equal(main.exactQueueDepth, false);
  } finally { await pi.close(); }
});

test('a failed open after owner publication emits a matching closing and removes listeners', async () => {
  const pi = await start(join(root, 'history'), { bound: 'history', failOwnerNotice: true });
  try {
    await until(() => pi.events(OWNER_EVENT).some(event => (event as OwnerEventV1).kind === 'closing'), 'owner closing');
    const owners = pi.events(OWNER_EVENT) as OwnerEventV1[];
    const ready = owners.find(event => event.kind === 'ready');
    const closing = owners.find(event => event.kind === 'closing');
    assert.ok(ready);
    assert.ok(closing);
    assert.equal(closing.ownerSessionId, ready.ownerSessionId);
    assert.equal(closing.ownerEpoch, ready.ownerEpoch);

    const before = pi.events(CONVERSATION_RESULT_EVENT).length;
    pi.bus.emit(CONVERSATION_REQUEST_EVENT, request(ready.ownerEpoch, 'conversation:submit', { text: 'must stay inert' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(pi.events(CONVERSATION_RESULT_EVENT).length, before, 'the failed owner removed its request listeners');
    assert.doesNotMatch(JSON.stringify(pi.published), /SECRET-OWNER-NOTICE-FAILURE/);
  } finally { await pi.close(); }
});

test('the documented bridge handler keeps accepted requests pending until a terminal result', () => {
  const guide = readFileSync(new URL('../docs/events-integration.md', import.meta.url), 'utf8');
  assert.match(guide, /result\.phase === 'accepted'/);
  assert.match(guide, /result\.phase !== 'completed' && result\.phase !== 'rejected'/);
  assert.match(guide, /result\.ownerSessionId !== owner\.ownerSessionId/);
  assert.match(guide, /result\.ownerEpoch !== owner\.ownerEpoch/);

  const owner = { ownerSessionId: 'session-owner', ownerEpoch: 'epoch-owner' };
  const pending = new Set(['request-1']);
  const base = { version: 1, clientId: 'bridge-1', requestId: 'request-1', ...owner } as const;
  applyDocumentedBridgeResult({ ...base, phase: 'accepted' }, owner, pending);
  assert.equal(pending.has('request-1'), true);
  applyDocumentedBridgeResult({ ...base, phase: 'completed' }, owner, pending);
  assert.equal(pending.has('request-1'), false);
});

test('real public events correlate one activity turn through working, responding, tool, attention, and settlement', async () => {
  const pi = await start(join(root, 'lifecycle'), { bound: 'delta', content: true });
  try {
    const epoch = pi.ownerEpoch();
    assert.ok(epoch);
    pi.bus.emit(OUTPUT_SUBSCRIBE_EVENT, request(epoch, 'output:subscribe', { subscriptionId: 'sub-1' }, { ownerSessionId: pi.manager.getSessionId() }));
    await until(() => pi.events(OUTPUT_EVENT).some(event => (event as OutputEventV1).kind === 'subscribed'), 'output subscription');

    const prompt = pi.session.prompt('Delta');
    await pi.deltaSeen;
    await until(() => (pi.events(MAIN_STATUS_EVENT) as MainStatusV1[]).some(status => status.phase === 'working'), 'working phase');
    const working = (pi.events(MAIN_STATUS_EVENT) as MainStatusV1[]).find(status => status.phase === 'working')!;
    assert.ok(working.turnId);
    pi.releaseDelta();
    await until(() => (pi.events(MAIN_STATUS_EVENT) as MainStatusV1[]).some(status => status.phase === 'responding'), 'responding phase');
    const responding = (pi.events(MAIN_STATUS_EVENT) as MainStatusV1[]).find(status => status.phase === 'responding')!;
    assert.equal(responding.turnId, working.turnId, 'one activity keeps one generated turn id');
    pi.releaseDone();
    await prompt;
    await until(() => (pi.events(MAIN_STATUS_EVENT) as MainStatusV1[]).some(status => status.phase === 'idle' && status.turnId === null), 'settlement');

    await until(() => (pi.events(OUTPUT_EVENT) as OutputEventV1[]).some(event => event.kind === 'final' && event.text === 'hello'), 'final output');
    const output = pi.events(OUTPUT_EVENT) as OutputEventV1[];
    const final = output.find(event => event.kind === 'final')!;
    assert.equal(final.turnId, working.turnId, 'output keeps the owner activity correlation');
    assert.equal(final.replacement, true);
    assert.equal(output.some(event => event.kind === 'completed'), true);
  } finally {
    pi.releaseDelta(); pi.releaseDone(); await pi.close();
  }
});

test('a real provider tool call and public UI prompt events update tool and attention metadata', async () => {
  const pi = await start(join(root, 'tool-attention'), { bound: 'tool' });
  try {
    const toolPrompt = pi.session.prompt('please use the tool');
    await until(() => (pi.events(MAIN_STATUS_EVENT) as MainStatusV1[]).some(status => status.currentTool === 'slow_tool'), 'tool activity');
    await toolPrompt;

    await pi.session.extensionRunner.emit({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'input', title: 'SECRET-PROMPT-TITLE' });
    await until(() => (pi.events(MAIN_STATUS_EVENT) as MainStatusV1[]).some(status => status.phase === 'awaiting-input'), 'attention phase');
    const attention = pi.events(ATTENTION_EVENT) as AttentionEventV1[];
    assert.equal(attention[0].kind, 'started');
    assert.doesNotMatch(JSON.stringify(attention), /SECRET-PROMPT-TITLE|title|answer|options/);
    await pi.session.extensionRunner.emit({ type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'input', title: 'SECRET-PROMPT-TITLE' });
  } finally { await pi.close(); }
});

test('error and aborted turns publish fixed terminal output facts without provider error text', async () => {
  const pi = await start(join(root, 'errors'), { bound: 'errors', content: true });
  try {
    const epoch = pi.ownerEpoch();
    assert.ok(epoch);
    pi.bus.emit(OUTPUT_SUBSCRIBE_EVENT, request(epoch, 'output:subscribe', { subscriptionId: 'sub-1' }, { ownerSessionId: pi.manager.getSessionId() }));
    await until(() => pi.events(OUTPUT_EVENT).some(event => (event as OutputEventV1).kind === 'subscribed'), 'subscription');
    void pi.session.prompt('Error').catch(() => {});
    await until(() => pi.events(OUTPUT_EVENT).some(event => (event as OutputEventV1).kind === 'failed'), 'failed terminal');
    const failed = pi.events(OUTPUT_EVENT).find(event => (event as OutputEventV1).kind === 'failed') as OutputEventV1;
    assert.equal(failed.errorCode, 'INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(pi.events(OUTPUT_EVENT)), /SECRET-PROVIDER-ERROR/);

  } finally { await pi.close(); }

  const abortedPi = await start(join(root, 'aborted'), { bound: 'abort', content: true });
  try {
    const epoch = abortedPi.ownerEpoch();
    assert.ok(epoch);
    abortedPi.bus.emit(OUTPUT_SUBSCRIBE_EVENT, request(epoch, 'output:subscribe', { subscriptionId: 'sub-1' }, { ownerSessionId: abortedPi.manager.getSessionId() }));
    await until(() => abortedPi.events(OUTPUT_EVENT).some(event => (event as OutputEventV1).kind === 'subscribed'), 'abort subscription');
    const aborted = abortedPi.session.prompt('Abort');
    await abortedPi.abortSeen;
    await abortedPi.session.abort();
    await aborted.catch(() => {});
    await until(() => abortedPi.events(OUTPUT_EVENT).some(event => (event as OutputEventV1).kind === 'aborted'), 'aborted terminal');
  } finally { await abortedPi.close(); }
});

test('content-off rejects access and emits no assistant text, while a late subscriber gets retained finals', async () => {
  const off = await start(join(root, 'content-off'), { bound: 'content-off' });
  try {
    const epoch = off.ownerEpoch();
    assert.ok(epoch);
    off.bus.emit(OUTPUT_SUBSCRIBE_EVENT, request(epoch, 'output:subscribe', { subscriptionId: 'sub-1' }, { ownerSessionId: off.manager.getSessionId() }));
    await until(() => off.events(OUTPUT_EVENT).some(event => (event as OutputEventV1).kind === 'rejected'), 'disabled rejection');
    assert.equal((off.events(OUTPUT_EVENT)[0] as OutputEventV1).errorCode, 'DISABLED');
    const prompt = off.session.prompt('Delta');
    await off.deltaSeen; off.releaseDelta(); off.releaseDone(); await prompt;
    assert.equal(off.events(OUTPUT_EVENT).filter(event => (event as OutputEventV1).kind === 'final').length, 0);
  } finally { await off.close(); }

  const on = await start(join(root, 'late-content'), { bound: 'late', content: true });
  try {
    const prompt = on.session.prompt('Delta');
    await on.deltaSeen; on.releaseDelta(); on.releaseDone(); await prompt;
    const epoch = on.ownerEpoch();
    assert.ok(epoch);
    on.bus.emit(OUTPUT_SUBSCRIBE_EVENT, request(epoch, 'output:subscribe', { subscriptionId: 'late' }, { ownerSessionId: on.manager.getSessionId() }));
    await until(() => on.events(OUTPUT_EVENT).some(event => { const output = event as OutputEventV1; return output.kind === 'final' && output.text === 'hello'; }), 'late retained final');
  } finally { await on.close(); }
});

test('owner ping serves a late host and unsupported input requests leave local journaling untouched', async () => {
  const pi = await start(join(root, 'ping-input'), { bound: 'ping' });
  try {
    const before = pi.manager.getEntries().length;
    const epoch = pi.ownerEpoch();
    assert.ok(epoch);
    pi.bus.emit(CONVERSATION_REQUEST_EVENT, request(epoch, 'conversation:submit', { text: 'SECRET-PROMPT' }, { ownerSessionId: pi.manager.getSessionId() }));
    await until(() => pi.events(CONVERSATION_RESULT_EVENT).length === 1, 'unsupported result');
    const result = pi.events(CONVERSATION_RESULT_EVENT)[0] as EventRequestResultV1;
    assert.equal(result.outcome.code, 'UNSUPPORTED_API');
    assert.doesNotMatch(JSON.stringify(result), /SECRET-PROMPT/);
    assert.equal(pi.manager.getEntries().length, before, 'an unsupported event request is not a Pi input');

    await pi.session.prompt('Local prompt');
    await until(() => JSON.stringify(pi.manager.getEntries()).includes('Local prompt'), 'local prompt journal');

    const mainBefore = pi.events(MAIN_STATUS_EVENT).length;
    pi.bus.emit(MAIN_PING_EVENT, { late: true });
    await until(() => pi.events(MAIN_STATUS_EVENT).length > mainBefore, 'late owner ping');
  } finally { await pi.close(); }
});

test('control is default-off and an enabled owner performs one real Children spawn', async () => {
  const off = await start(join(root, 'control-off'), { bound: 'control' });
  try {
    const epoch = off.ownerEpoch();
    assert.ok(epoch);
    off.bus.emit(AGENT_REQUEST_EVENT, request(epoch, 'agent:spawn', {
      tasks: [{ task: 'control hold', model: 'fixture/fixture', thinking: 'off' }],
    }, { ownerSessionId: off.manager.getSessionId() }));
    await until(() => off.events(AGENT_RESULT_EVENT).length === 1, 'disabled control result');
    assert.equal((off.events(AGENT_RESULT_EVENT)[0] as EventRequestResultV1).outcome.code, 'DISABLED');
  } finally { await off.close(); }

  const on = await start(join(root, 'control-on'), { bound: 'control', control: true });
  try {
    const epoch = on.ownerEpoch();
    assert.ok(epoch);
    on.bus.emit(AGENT_REQUEST_EVENT, request(epoch, 'agent:spawn', {
      tasks: [{ task: 'control hold', model: 'fixture/fixture', thinking: 'off' }],
    }, { ownerSessionId: on.manager.getSessionId() }));
    await until(() => (on.events(AGENT_RESULT_EVENT) as EventRequestResultV1[]).some(result => result.phase === 'completed'), 'control terminal');
    const result = (on.events(AGENT_RESULT_EVENT) as EventRequestResultV1[]).find(candidate => candidate.phase === 'completed')!;
    assert.equal(result.outcome.status, 'ok');
    const value = result.outcome.value as { runIds: string[] };
    assert.equal(value.runIds.length, 1);
    assert.match(value.runIds[0], /^[A-Za-z0-9-]+$/);
    assert.doesNotMatch(JSON.stringify(result), /control hold/);
  } finally { await on.close(); }
});

test('real history reads expose only bounded branch text and a finalized child assistant result', async () => {
  const off = await start(join(root, 'history-off'), { bound: 'history-off' });
  try {
    const epoch = off.ownerEpoch();
    assert.ok(epoch);
    off.bus.emit(HISTORY_REQUEST_EVENT, request(epoch, 'history:recent', { limit: 20, cursor: null }, {
      ownerSessionId: off.manager.getSessionId(), requestId: 'history-off-request',
    }));
    await until(() => off.events(HISTORY_RESULT_EVENT).length === 1, 'history disabled result');
    assert.equal((off.events(HISTORY_RESULT_EVENT)[0] as EventRequestResultV1).outcome.code, 'DISABLED');
  } finally { await off.close(); }

  const pi = await start(join(root, 'history'), { bound: 'history', content: true, control: true });
  try {
    const epoch = pi.ownerEpoch();
    assert.ok(epoch);
    const ownerSessionId = pi.manager.getSessionId();
    await pi.session.prompt('Local history text');
    await until(() => pi.manager.getBranch().some(entry => entry.type === 'message'), 'history journal');

    pi.bus.emit(HISTORY_REQUEST_EVENT, request(epoch, 'history:recent', { limit: 20, cursor: null }, {
      ownerSessionId, requestId: 'history-recent-request',
    }));
    await until(() => (pi.events(HISTORY_RESULT_EVENT) as EventRequestResultV1[]).some(result => result.requestId === 'history-recent-request' && result.phase === 'completed'), 'history recent terminal');
    const recent = (pi.events(HISTORY_RESULT_EVENT) as EventRequestResultV1[]).find(result => result.requestId === 'history-recent-request' && result.phase === 'completed')!;
    const page = recent.outcome.value as { scope: string; items: { role: string; text: string }[]; truncated: boolean; omitted: number };
    assert.equal(page.scope, 'current-session-branch');
    assert.ok(page.items.some(item => item.role === 'user' && item.text.includes('Local history text')));
    assert.ok(page.items.some(item => item.role === 'assistant' && item.text.includes('ok')));
    assert.ok(page.items.length <= 20);
    assert.equal(JSON.stringify(page).includes('optchat.profile'), false);

    pi.bus.emit(AGENT_REQUEST_EVENT, request(epoch, 'agent:spawn', {
      tasks: [{ task: 'history child result', model: 'fixture/fixture', thinking: 'off' }],
    }, { ownerSessionId, requestId: 'history-spawn-request' }));
    await until(() => (pi.events(AGENT_RESULT_EVENT) as EventRequestResultV1[]).some(result => result.requestId === 'history-spawn-request' && result.phase === 'completed'), 'history child spawn');
    const spawned = (pi.events(AGENT_RESULT_EVENT) as EventRequestResultV1[]).find(result => result.requestId === 'history-spawn-request' && result.phase === 'completed')!;
    const runId = (spawned.outcome.value as { runIds: string[] }).runIds[0];
    const metadataPath = join(profilePath('history'), 'runs', `${runId}.optchat.json`);
    await until(() => {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { state?: string };
        return metadata.state === 'completed';
      } catch { return false; }
    }, 'history child completion');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { started: number; report?: string };

    pi.bus.emit(HISTORY_REQUEST_EVENT, request(epoch, 'history:result', { runId, expectedStartedAt: metadata.started }, {
      ownerSessionId, requestId: 'history-result-request',
    }));
    await until(() => (pi.events(HISTORY_RESULT_EVENT) as EventRequestResultV1[]).some(result => result.requestId === 'history-result-request' && result.phase === 'completed'), 'history result terminal');
    const selected = (pi.events(HISTORY_RESULT_EVENT) as EventRequestResultV1[]).find(result => result.requestId === 'history-result-request' && result.phase === 'completed')!;
    const resultValue = selected.outcome.value as { runId: string; state: string; ready: boolean; text: string };
    assert.equal(resultValue.runId, runId);
    assert.equal(resultValue.state, 'completed');
    assert.equal(resultValue.ready, true);
    assert.equal(resultValue.text, 'ok');
    assert.doesNotMatch(JSON.stringify(selected), /history child result|SECRET-PROVIDER-ERROR/);
    assert.deepEqual(Object.keys(resultValue).sort(), ['ready', 'runId', 'state', 'text', 'truncated', 'version']);
  } finally { await pi.close(); }
});

test('a connected window is not an owner', async () => {
  const bus = createEventBus();
  const owner = await start(join(root, 'connected-owner'), { bound: 'work', bus });
  try {
    const connected = await start(join(root, 'connected-window'), { bound: 'work', bus, select: async (_title, choices) => choices.find(choice => choice.includes('connected subagent conversation')) });
    try {
      const connectedSession = connected.manager.getSessionId();
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal((owner.events(OWNER_EVENT) as OwnerEventV1[]).some(event => event.ownerSessionId === connectedSession), false);
    } finally { await connected.close(); }
  } finally { await owner.close(); }
});

test('TUI, RPC, print, and JSON owners publish; plain and joined sessions do not', async () => {
  for (const mode of ['tui', 'rpc', 'print', 'json'] as const) {
    const pi = await start(join(root, `mode-${mode}`), { bound: 'work', mode });
    try {
      assert.ok(pi.events(OWNER_EVENT).length, `${mode} owns the profile and publishes ready`);
    } finally { await pi.close(); }
  }

  const plain = await start(join(root, 'plain'), { mode: 'rpc' });
  try { assert.deepEqual(plain.events(OWNER_EVENT), [], 'plain Pi is not an owner'); }
  finally { await plain.close(); }

  const bus = createEventBus();
  const owner = await start(join(root, 'joined-owner'), { bound: 'work', bus });
  try {
    const joined = await start(join(root, 'joined-client'), { bound: 'work', mode: 'print', bus, connect: 'join' });
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      const joinedSession = joined.manager.getSessionId();
      assert.equal((owner.events(OWNER_EVENT) as OwnerEventV1[]).some(event => event.ownerSessionId === joinedSession), false);
    } finally { await joined.close(); }
  } finally { await owner.close(); }
});
