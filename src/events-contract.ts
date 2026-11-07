/**
 * Explicit, privacy-bounded contracts for OptChat's in-process Pi event integrations.
 *
 * This module contains no bus or owner wiring. It defines literal channels,
 * finite limits, fixed errors, and allowlisted request DTOs. Unknown additive
 * fields are ignored; they are never copied into an executable DTO or a
 * semantic fingerprint.
 */

export const MAIN_STATUS_EVENT = 'optchat:main:status:v1';
export const MAIN_PING_EVENT = 'optchat:main:ping:v1';
export const OWNER_EVENT = 'optchat:owner:event:v1';
export const CONVERSATION_REQUEST_EVENT = 'optchat:conversation:request:v1';
export const CONVERSATION_RESULT_EVENT = 'optchat:conversation:result:v1';
export const OUTPUT_SUBSCRIBE_EVENT = 'optchat:output:subscribe:v1';
export const OUTPUT_UNSUBSCRIBE_EVENT = 'optchat:output:unsubscribe:v1';
export const OUTPUT_EVENT = 'optchat:output:event:v1';
export const ATTENTION_EVENT = 'optchat:attention:event:v1';
export const ATTENTION_REPLY_EVENT = 'optchat:attention:reply:v1';
export const ATTENTION_RESULT_EVENT = 'optchat:attention:result:v1';
export const AGENT_REQUEST_EVENT = 'optchat:agent:request:v1';
export const AGENT_RESULT_EVENT = 'optchat:agent:result:v1';
export const HISTORY_REQUEST_EVENT = 'optchat:history:request:v1';
export const HISTORY_RESULT_EVENT = 'optchat:history:result:v1';

export const EVENT_CHANNELS = Object.freeze({
  mainStatus: MAIN_STATUS_EVENT,
  mainPing: MAIN_PING_EVENT,
  ownerEvent: OWNER_EVENT,
  conversationRequest: CONVERSATION_REQUEST_EVENT,
  conversationResult: CONVERSATION_RESULT_EVENT,
  outputSubscribe: OUTPUT_SUBSCRIBE_EVENT,
  outputUnsubscribe: OUTPUT_UNSUBSCRIBE_EVENT,
  outputEvent: OUTPUT_EVENT,
  attentionEvent: ATTENTION_EVENT,
  attentionReply: ATTENTION_REPLY_EVENT,
  attentionResult: ATTENTION_RESULT_EVENT,
  agentRequest: AGENT_REQUEST_EVENT,
  agentResult: AGENT_RESULT_EVENT,
  historyRequest: HISTORY_REQUEST_EVENT,
  historyResult: HISTORY_RESULT_EVENT,
});

export type EventChannelName = typeof EVENT_CHANNELS[keyof typeof EVENT_CHANNELS];
export const EVENTS_INTEGRATIONS_VERSION = 1;
export const EVENTS_CONTENT_FLAG = 'optchat-events-content';
export const EVENTS_CONTROL_FLAG = 'optchat-events-control';

/**
 * The settled limits for the integrations contract. These are finite and
 * deliberately visible to callers; a lower value requires the contract,
 * capabilities, documentation, and tests to change together.
 */
export const EVENT_LIMITS = Object.freeze({
  executableStringBytes: 64 * 1024,
  inputTextBytes: 32 * 1024,
  spawnTasks: 8,
  inFlightRequests: 16,
  idempotencyRecords: 256,
  retainedResultBytes: 4 * 1024 * 1024,
  retryWindowMs: 10 * 60 * 1000,
  operationDeadlineMs: 30 * 1000,
  metadataCoalesceMs: 250,
  outputSubscriptions: 8,
  retainedMessageBytes: 128 * 1024,
  retainedMessages: 16,
  recoveryCacheBytes: 512 * 1024,
  outputEventBytes: 8 * 1024,
  outputBatchIntervalMs: 100,
  queuedDeltaBytes: 32 * 1024,
  historyItems: 20,
  historyPageBytes: 64 * 1024,
  historyItemBytes: 16 * 1024,
  historyCandidates: 200,
  historyCursors: 16,
  historyCursorBytes: 512 * 1024,
  historyCursorTtlMs: 60 * 1000,
  runResultTextBytes: 32 * 1024,
});

export type EventLimitsV1 = typeof EVENT_LIMITS;

export const EVENT_ERROR_CODES = Object.freeze([
  'INVALID_REQUEST',
  'STALE_OWNER',
  'STALE_RUN',
  'DISABLED',
  'UNSUPPORTED_API',
  'NOT_FOUND',
  'INVALID_STATE',
  'POLICY_DENIED',
  'CAPACITY',
  'REQUEST_CONFLICT',
  'OUTCOME_UNKNOWN',
  'OWNER_CLOSING',
  'INTERNAL_ERROR',
] as const);

export type EventErrorCode = typeof EVENT_ERROR_CODES[number];

const ERROR_MESSAGES: Readonly<Record<EventErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: 'OptChat event request is invalid.',
  STALE_OWNER: 'OptChat event request targets an owner that is no longer current.',
  STALE_RUN: 'OptChat event request targets a run that is no longer current.',
  DISABLED: 'OptChat event integration is disabled.',
  UNSUPPORTED_API: 'OptChat event operation is not supported by the public Pi API.',
  NOT_FOUND: 'OptChat event target was not found.',
  INVALID_STATE: 'OptChat event target is not in a valid state.',
  POLICY_DENIED: 'OptChat event request was denied by policy.',
  CAPACITY: 'OptChat event integration is at capacity.',
  REQUEST_CONFLICT: 'OptChat event request conflicts with an earlier request.',
  OUTCOME_UNKNOWN: 'OptChat event operation outcome is unknown.',
  OWNER_CLOSING: 'OptChat event owner is closing.',
  INTERNAL_ERROR: 'OptChat event integration failed internally.',
});

export interface EventErrorV1 {
  readonly code: EventErrorCode;
  readonly message: string;
}

/** A safe error object. It never contains an exception message or request data. */
export function eventError(code: EventErrorCode): EventErrorV1 {
  return Object.freeze({ code, message: ERROR_MESSAGES[code] });
}

export const SUPPORTED_OPERATIONS = Object.freeze([
  'output:subscribe',
  'output:unsubscribe',
  'output:resync',
  'agent:spawn',
  'agent:steer',
  'agent:stop',
  'agent:resume',
  'history:recent',
  'history:result',
] as const);

export const UNSUPPORTED_OPERATIONS = Object.freeze([
  'conversation:submit',
  'conversation:queue',
  'conversation:steer',
  'attention:reply',
] as const);

export type SupportedOperation = typeof SUPPORTED_OPERATIONS[number];
export type UnsupportedOperation = typeof UNSUPPORTED_OPERATIONS[number];
export type EventOperation = SupportedOperation | UnsupportedOperation;

const OPERATION_SET: ReadonlySet<string> = new Set<string>([...SUPPORTED_OPERATIONS, ...UNSUPPORTED_OPERATIONS]);
const UNSUPPORTED_SET: ReadonlySet<string> = new Set<string>(UNSUPPORTED_OPERATIONS);

export function isSupportedOperation(operation: string): operation is SupportedOperation {
  return SUPPORTED_OPERATIONS.includes(operation as SupportedOperation);
}

export function isUnsupportedOperation(operation: string): operation is UnsupportedOperation {
  return UNSUPPORTED_SET.has(operation);
}

/** The request channel for an operation, if that operation has one. */
export function requestChannel(operation: EventOperation): EventChannelName | undefined {
  switch (operation) {
    case 'conversation:submit':
    case 'conversation:queue':
    case 'conversation:steer': return CONVERSATION_REQUEST_EVENT;
    case 'attention:reply': return ATTENTION_REPLY_EVENT;
    case 'output:subscribe':
    case 'output:resync': return OUTPUT_SUBSCRIBE_EVENT;
    case 'output:unsubscribe': return OUTPUT_UNSUBSCRIBE_EVENT;
    case 'agent:spawn':
    case 'agent:steer':
    case 'agent:stop':
    case 'agent:resume': return AGENT_REQUEST_EVENT;
    case 'history:recent':
    case 'history:result': return HISTORY_REQUEST_EVENT;
  }
}

/** The result channel for an operation, if that operation has one. */
export function resultChannel(operation: EventOperation): EventChannelName | undefined {
  switch (operation) {
    case 'conversation:submit':
    case 'conversation:queue':
    case 'conversation:steer': return CONVERSATION_RESULT_EVENT;
    case 'attention:reply': return ATTENTION_RESULT_EVENT;
    case 'output:subscribe':
    case 'output:unsubscribe':
    case 'output:resync': return OUTPUT_EVENT;
    case 'agent:spawn':
    case 'agent:steer':
    case 'agent:stop':
    case 'agent:resume': return AGENT_RESULT_EVENT;
    case 'history:recent':
    case 'history:result': return HISTORY_RESULT_EVENT;
  }
}

export interface IntegrationsCapabilityV1 {
  readonly version: 1;
  readonly ownerEpoch: string;
  readonly metadata: { readonly enabled: true };
  readonly content: { readonly enabled: boolean };
  readonly control: { readonly enabled: boolean };
  readonly unsupported: readonly {
    readonly operation: UnsupportedOperation;
    readonly reason: 'PUBLIC_API_LIMIT';
  }[];
  readonly limits: EventLimitsV1;
}

export interface IntegrationPolicyFlags {
  readonly content: boolean;
  readonly control: boolean;
}

/** The additive integrations capability. The existing status capability remains authoritative. */
export function integrationsCapabilities(
  ownerEpoch: string,
  flags: IntegrationPolicyFlags,
): IntegrationsCapabilityV1 | undefined {
  if (!isIdentifier(ownerEpoch)) return undefined;
  return Object.freeze({
    version: EVENTS_INTEGRATIONS_VERSION,
    ownerEpoch,
    metadata: Object.freeze({ enabled: true as const }),
    content: Object.freeze({ enabled: flags.content === true }),
    control: Object.freeze({ enabled: flags.control === true }),
    unsupported: Object.freeze(UNSUPPORTED_OPERATIONS.map(operation => Object.freeze({
      operation,
      reason: 'PUBLIC_API_LIMIT' as const,
    }))),
    limits: EVENT_LIMITS,
  });
}

export interface OwnerEpochEnvelopeV1 {
  readonly version: 1;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
}

export type EventRequestPhase = 'rejected' | 'accepted' | 'completed';

export interface EventRequestIdentityV1 {
  readonly clientId: string;
  readonly requestId: string;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly operation?: EventOperation;
}

export interface OutputSubscriptionPayloadV1 {
  readonly subscriptionId: string;
}

export interface ConversationPayloadV1 {
  readonly text: string;
}

export interface AttentionReplyPayloadV1 {
  readonly attentionId: string;
  readonly answer: string | null;
}

export interface SpawnTaskV1 {
  readonly task: string;
  readonly model: string | null;
  readonly thinking: string | null;
}

export interface AgentSpawnPayloadV1 {
  readonly tasks: readonly SpawnTaskV1[];
}

export interface AgentTargetPayloadV1 {
  readonly runId: string;
  readonly expectedStartedAt: number;
}

/** One spawned run: the id a later request names, and the token that says which generation it means. */
export interface AgentSpawnRunV1 {
  readonly runId: string;
  /** When the run started, in epoch milliseconds, or null when it cannot be published safely. */
  readonly startedAt: number | null;
}

/** What `agent:spawn` returns: the run ids, and each run's generation token. */
export interface AgentSpawnResultV1 {
  readonly runIds: readonly string[];
  readonly runs: readonly AgentSpawnRunV1[];
}

/**
 * A run's generation token: the epoch milliseconds it started at, or null when it cannot be published safely.
 * A host sends it back as `expectedStartedAt`, which is what says which generation of a run a request means.
 * The token must be a whole positive millisecond, because that is all the request parser accepts.
 */
export function generationToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface AgentMessageTargetPayloadV1 extends AgentTargetPayloadV1 {
  readonly message: string;
}

export interface HistoryRecentPayloadV1 {
  readonly limit: number | null;
  readonly cursor: string | null;
}

export interface HistoryResultPayloadV1 {
  readonly runId: string;
  readonly expectedStartedAt: number;
}

interface EventRequestBaseV1 extends EventRequestIdentityV1 {
  readonly version: 1;
  readonly operation: EventOperation;
}

export type EventRequestV1 =
  | (EventRequestBaseV1 & { readonly operation: 'output:subscribe' | 'output:unsubscribe' | 'output:resync'; readonly payload: OutputSubscriptionPayloadV1 })
  | (EventRequestBaseV1 & { readonly operation: 'conversation:submit' | 'conversation:queue' | 'conversation:steer'; readonly payload: ConversationPayloadV1 })
  | (EventRequestBaseV1 & { readonly operation: 'attention:reply'; readonly payload: AttentionReplyPayloadV1 })
  | (EventRequestBaseV1 & { readonly operation: 'agent:spawn'; readonly payload: AgentSpawnPayloadV1 })
  | (EventRequestBaseV1 & { readonly operation: 'agent:steer' | 'agent:resume'; readonly payload: AgentMessageTargetPayloadV1 })
  | (EventRequestBaseV1 & { readonly operation: 'agent:stop'; readonly payload: AgentTargetPayloadV1 })
  | (EventRequestBaseV1 & { readonly operation: 'history:recent'; readonly payload: HistoryRecentPayloadV1 })
  | (EventRequestBaseV1 & { readonly operation: 'history:result'; readonly payload: HistoryResultPayloadV1 });

export type JsonPrimitiveV1 = string | number | boolean | null;
export type JsonValueV1 = JsonPrimitiveV1 | readonly JsonValueV1[] | { readonly [key: string]: JsonValueV1 };

export interface EventRequestOutcomeV1 {
  readonly status: 'ok' | 'error';
  readonly code: EventErrorCode | null;
  readonly value: JsonValueV1 | null;
}

export interface EventRequestResultV1 {
  readonly version: 1;
  readonly clientId: string;
  readonly requestId: string;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly operation: EventOperation;
  readonly phase: EventRequestPhase;
  readonly sequence: number;
  readonly outcome: EventRequestOutcomeV1;
}

export interface EventResultInput {
  readonly identity: EventRequestIdentityV1;
  readonly operation: EventOperation;
  readonly phase: EventRequestPhase;
  readonly sequence: number;
  readonly outcome: EventRequestOutcomeV1;
}

/** Builds an exact-key result envelope. */
export function eventRequestResult(input: EventResultInput): EventRequestResultV1 {
  return Object.freeze({
    version: EVENTS_INTEGRATIONS_VERSION,
    clientId: input.identity.clientId,
    requestId: input.identity.requestId,
    ownerSessionId: input.identity.ownerSessionId,
    ownerEpoch: input.identity.ownerEpoch,
    operation: input.operation,
    phase: input.phase,
    sequence: input.sequence,
    outcome: Object.freeze({
      status: input.outcome.status,
      code: input.outcome.code,
      value: input.outcome.value,
    }),
  });
}

export type MainPhaseV1 = 'idle' | 'working' | 'responding' | 'awaiting-input' | 'closing';

export interface MainStatusV1 {
  readonly version: 1;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly phase: MainPhaseV1;
  readonly turnId: string | null;
  readonly currentTool: string | null;
  /** The number of observed tools, or null when the bounded set overflowed. */
  readonly toolCount: number | null;
  readonly pending: boolean;
  readonly queueDepth: null;
  readonly exactQueueDepth: false;
  readonly sampledAt: number;
}

export interface OwnerEventV1 {
  readonly version: 1;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly generation: number;
  readonly kind: 'ready' | 'replayed-ready' | 'closing';
}

export interface AttentionEventV1 {
  readonly version: 1;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly attentionId: string;
  readonly kind: 'started' | 'ended';
  readonly ambiguous: boolean;
}

export type OutputEventKindV1 =
  | 'subscribed'
  | 'unsubscribed'
  | 'rejected'
  | 'text_delta'
  | 'final'
  | 'gap'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface OutputEventV1 {
  readonly version: 1;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly clientId: string | null;
  readonly subscriptionId: string;
  readonly requestId: string | null;
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly sequence: number;
  readonly kind: OutputEventKindV1;
  readonly text: string;
  readonly truncated: boolean;
  readonly gap: boolean;
  readonly replacement: boolean;
  readonly snapshotId: string | null;
  readonly snapshotIndex: number | null;
  readonly snapshotCount: number | null;
  readonly errorCode: EventErrorCode | null;
}

export interface HistoryItemV1 {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly truncated: boolean;
}

export interface HistoryPageV1 {
  readonly version: 1;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly scope: 'current-session-branch';
  readonly items: readonly HistoryItemV1[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly omitted: number;
}

export interface HistoryRunResultV1 {
  readonly version: 1;
  readonly runId: string;
  readonly state: 'running' | 'waiting' | 'paused' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted';
  readonly ready: boolean;
  readonly text: string;
  readonly truncated: boolean;
}

export type EventParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EventErrorCode; readonly identity?: EventRequestIdentityV1 };

const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const THINKING_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN_SEMANTIC_KEYS: ReadonlySet<string> = new Set([
  'cwd',
  'parent',
  'parentId',
  'parentSessionId',
  'callerCwd',
  'callerParent',
  'callerParentId',
]);

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try { return !Array.isArray(value); }
  catch { return false; }
}

type PropertyRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'inaccessible' }
  | { readonly kind: 'value'; readonly value: unknown };

function readProperty(object: object, key: string): PropertyRead {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return { kind: 'missing' };
    if (!('value' in descriptor)) return { kind: 'inaccessible' };
    return { kind: 'value', value: descriptor.value };
  } catch {
    return { kind: 'inaccessible' };
  }
}

function requiredString(
  object: object,
  key: string,
  predicate: (value: string) => boolean,
): { ok: true; value: string } | { ok: false; error: EventErrorCode } {
  const read = readProperty(object, key);
  if (read.kind !== 'value' || typeof read.value !== 'string' || !predicate(read.value)) {
    return { ok: false, error: 'INVALID_REQUEST' };
  }
  return { ok: true, value: read.value };
}

function optionalString(
  object: object,
  key: string,
  predicate: (value: string) => boolean,
): { ok: true; value: string | null } | { ok: false; error: EventErrorCode } {
  const read = readProperty(object, key);
  if (read.kind === 'missing') return { ok: true, value: null };
  if (read.kind === 'value' && read.value === null) return { ok: true, value: null };
  if (read.kind !== 'value' || typeof read.value !== 'string' || !predicate(read.value)) {
    return { ok: false, error: 'INVALID_REQUEST' };
  }
  return { ok: true, value: read.value };
}

function optionalFiniteInteger(
  object: object,
  key: string,
  minimum: number,
  maximum: number,
): { ok: true; value: number | null } | { ok: false; error: EventErrorCode } {
  const read = readProperty(object, key);
  if (read.kind === 'missing') return { ok: true, value: null };
  if (read.kind === 'value' && read.value === null) return { ok: true, value: null };
  if (read.kind !== 'value' || typeof read.value !== 'number' || !Number.isSafeInteger(read.value)
      || read.value < minimum || read.value > maximum) {
    return { ok: false, error: 'INVALID_REQUEST' };
  }
  return { ok: true, value: read.value };
}

function requiredFiniteInteger(
  object: object,
  key: string,
  minimum: number,
): { ok: true; value: number } | { ok: false; error: EventErrorCode } {
  const read = readProperty(object, key);
  if (read.kind !== 'value' || typeof read.value !== 'number' || !Number.isSafeInteger(read.value)
      || read.value < minimum) {
    return { ok: false, error: 'INVALID_REQUEST' };
  }
  return { ok: true, value: read.value };
}

/**
 * Finds forbidden caller/parent semantics without invoking accessors. Other
 * additive fields, including accessor-valued ones, are ignored.
 */
function containsForbiddenSemanticField(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  let depth = 0;
  while (pending.length) {
    const current = pending.pop();
    if ((typeof current !== 'object' && typeof current !== 'function') || current === null) continue;
    if (seen.has(current)) return true;
    seen.add(current);
    if (++depth > 4096) return true;
    let keys: PropertyKey[];
    try { keys = Reflect.ownKeys(current); }
    catch { return true; }
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      if (FORBIDDEN_SEMANTIC_KEYS.has(key)) return true;
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(current, key); }
      catch { return true; }
      if (!descriptor || !('value' in descriptor)) continue;
      pending.push(descriptor.value);
    }
  }
  return false;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Counts executable string bytes. JSON escaping is included so an escaped
 * transport representation cannot evade the advertised parsed-content bound.
 */
function executableStringByteCount(value: unknown): number {
  let bytes = 0;
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      const escaped = JSON.stringify(current).slice(1, -1);
      bytes += Math.max(utf8Bytes(current), utf8Bytes(escaped));
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    if (seen.has(current)) return Number.POSITIVE_INFINITY;
    seen.add(current);
    const keys = Object.keys(current);
    for (const key of keys) pending.push((current as Record<string, unknown>)[key]);
  }
  return bytes;
}

/** The number of executable string bytes in a validated request. */
export function executableStringBytes(request: EventRequestV1): number {
  return executableStringByteCount(request);
}

function parseSubscriptionPayload(value: unknown): { ok: true; value: OutputSubscriptionPayloadV1 } | { ok: false; error: EventErrorCode } {
  if (!isObject(value)) return { ok: false, error: 'INVALID_REQUEST' };
  const id = requiredString(value, 'subscriptionId', isIdentifier);
  if (!id.ok) return id;
  return { ok: true, value: { subscriptionId: id.value } };
}

function parseConversationPayload(value: unknown): { ok: true; value: ConversationPayloadV1 } | { ok: false; error: EventErrorCode } {
  if (!isObject(value)) return { ok: false, error: 'INVALID_REQUEST' };
  const read = readProperty(value, 'text');
  if (read.kind !== 'value' || typeof read.value !== 'string') return { ok: false, error: 'INVALID_REQUEST' };
  if (utf8Bytes(read.value) > EVENT_LIMITS.inputTextBytes) return { ok: false, error: 'CAPACITY' };
  return { ok: true, value: { text: read.value } };
}

function parseAttentionReplyPayload(value: unknown): { ok: true; value: AttentionReplyPayloadV1 } | { ok: false; error: EventErrorCode } {
  if (!isObject(value)) return { ok: false, error: 'INVALID_REQUEST' };
  const id = requiredString(value, 'attentionId', isIdentifier);
  if (!id.ok) return id;
  const read = readProperty(value, 'answer');
  if (read.kind === 'missing') return { ok: true, value: { attentionId: id.value, answer: null } };
  if (read.kind === 'value' && read.value === null) {
    return { ok: true, value: { attentionId: id.value, answer: null } };
  }
  if (read.kind !== 'value' || typeof read.value !== 'string') {
    return { ok: false, error: 'INVALID_REQUEST' };
  }
  if (utf8Bytes(read.value) > EVENT_LIMITS.inputTextBytes) {
    return { ok: false, error: 'CAPACITY' };
  }
  return { ok: true, value: { attentionId: id.value, answer: read.value } };
}

function parseSpawnPayload(value: unknown): { ok: true; value: AgentSpawnPayloadV1 } | { ok: false; error: EventErrorCode } {
  if (!isObject(value)) return { ok: false, error: 'INVALID_REQUEST' };
  const read = readProperty(value, 'tasks');
  if (read.kind !== 'value' || !Array.isArray(read.value)) return { ok: false, error: 'INVALID_REQUEST' };
  if (read.value.length < 1 || read.value.length > EVENT_LIMITS.spawnTasks) return { ok: false, error: 'CAPACITY' };
  const tasks: SpawnTaskV1[] = [];
  for (const entry of read.value) {
    if (!isObject(entry)) return { ok: false, error: 'INVALID_REQUEST' };
    const taskRead = readProperty(entry, 'task');
    if (taskRead.kind !== 'value' || typeof taskRead.value !== 'string') return { ok: false, error: 'INVALID_REQUEST' };
    if (utf8Bytes(taskRead.value) > EVENT_LIMITS.inputTextBytes) return { ok: false, error: 'CAPACITY' };
    const task = { ok: true, value: taskRead.value } as const;
    const model = optionalString(entry, 'model', candidate => MODEL_IDENTIFIER.test(candidate));
    if (!model.ok) return model;
    const thinking = optionalString(entry, 'thinking', candidate => THINKING_IDENTIFIER.test(candidate));
    if (!thinking.ok) return thinking;
    tasks.push({ task: task.value, model: model.value, thinking: thinking.value });
  }
  return { ok: true, value: { tasks } };
}

function parseAgentTargetPayload(value: unknown): { ok: true; value: AgentTargetPayloadV1 } | { ok: false; error: EventErrorCode } {
  if (!isObject(value)) return { ok: false, error: 'INVALID_REQUEST' };
  const id = requiredString(value, 'runId', isIdentifier);
  if (!id.ok) return id;
  const started = requiredFiniteInteger(value, 'expectedStartedAt', 0);
  if (!started.ok) return started;
  return { ok: true, value: { runId: id.value, expectedStartedAt: started.value } };
}

function parseAgentMessageTargetPayload(value: unknown): { ok: true; value: AgentMessageTargetPayloadV1 } | { ok: false; error: EventErrorCode } {
  if (!isObject(value)) return { ok: false, error: 'INVALID_REQUEST' };
  const target = parseAgentTargetPayload(value);
  if (!target.ok) return target;
  const message = requiredString(value, 'message', candidate => utf8Bytes(candidate) <= EVENT_LIMITS.inputTextBytes);
  if (!message.ok) return message;
  return { ok: true, value: { runId: target.value.runId, expectedStartedAt: target.value.expectedStartedAt, message: message.value } };
}

function parseHistoryRecentPayload(value: unknown): { ok: true; value: HistoryRecentPayloadV1 } | { ok: false; error: EventErrorCode } {
  if (!isObject(value)) return { ok: false, error: 'INVALID_REQUEST' };
  const limit = optionalFiniteInteger(value, 'limit', 1, EVENT_LIMITS.historyItems);
  if (!limit.ok) return limit;
  const cursor = optionalString(value, 'cursor', isIdentifier);
  if (!cursor.ok) return cursor;
  return { ok: true, value: { limit: limit.value, cursor: cursor.value } };
}

function parseHistoryResultPayload(value: unknown): { ok: true; value: HistoryResultPayloadV1 } | { ok: false; error: EventErrorCode } {
  return parseAgentTargetPayload(value);
}

function identityFrom(
  clientId: string,
  requestId: string,
  ownerSessionId: string,
  ownerEpoch: string,
  operation?: EventOperation,
): EventRequestIdentityV1 {
  return operation === undefined
    ? { clientId, requestId, ownerSessionId, ownerEpoch }
    : { clientId, requestId, ownerSessionId, ownerEpoch, operation };
}

/**
 * Parses one request into an exact-key, allowlisted executable DTO.
 * Unknown additive fields are ignored. Forbidden caller/parent semantics are
 * rejected. No exception text or request body is returned on failure.
 */
export function parseEventRequest(value: unknown): EventParseResult<EventRequestV1> {
  if (!isObject(value)) return { ok: false, error: 'INVALID_REQUEST' };

  const versionRead = readProperty(value, 'version');
  if (versionRead.kind === 'missing') return { ok: false, error: 'INVALID_REQUEST' };
  if (versionRead.kind !== 'value' || typeof versionRead.value !== 'number' || !Number.isFinite(versionRead.value)) {
    return { ok: false, error: 'INVALID_REQUEST' };
  }
  if (versionRead.value !== EVENTS_INTEGRATIONS_VERSION) return { ok: false, error: 'UNSUPPORTED_API' };

  const client = requiredString(value, 'clientId', isIdentifier);
  const request = requiredString(value, 'requestId', isIdentifier);
  const session = requiredString(value, 'ownerSessionId', isIdentifier);
  const epoch = requiredString(value, 'ownerEpoch', isIdentifier);
  if (!client.ok || !request.ok || !session.ok) return { ok: false, error: 'INVALID_REQUEST' };
  if (!epoch.ok) return { ok: false, error: 'STALE_OWNER' };

  const operationRead = readProperty(value, 'operation');
  if (operationRead.kind !== 'value' || typeof operationRead.value !== 'string') {
    return { ok: false, error: 'INVALID_REQUEST' };
  }
  if (!OPERATION_SET.has(operationRead.value)) {
    return {
      ok: false,
      error: 'UNSUPPORTED_API',
      identity: identityFrom(client.value, request.value, session.value, epoch.value),
    };
  }
  const operation = operationRead.value as EventOperation;

  if (containsForbiddenSemanticField(value)) {
    return {
      ok: false,
      error: 'POLICY_DENIED',
      identity: identityFrom(client.value, request.value, session.value, epoch.value, operation),
    };
  }

  const payloadRead = readProperty(value, 'payload');
  if (payloadRead.kind !== 'value' || !isObject(payloadRead.value)) {
    return {
      ok: false,
      error: 'INVALID_REQUEST',
      identity: identityFrom(client.value, request.value, session.value, epoch.value, operation),
    };
  }
  if (containsForbiddenSemanticField(payloadRead.value)) {
    return {
      ok: false,
      error: 'POLICY_DENIED',
      identity: identityFrom(client.value, request.value, session.value, epoch.value, operation),
    };
  }

  let payload: OutputSubscriptionPayloadV1 | ConversationPayloadV1 | AttentionReplyPayloadV1
    | AgentSpawnPayloadV1 | AgentTargetPayloadV1 | AgentMessageTargetPayloadV1 | HistoryRecentPayloadV1 | HistoryResultPayloadV1;
  let parsed: { ok: true; value: typeof payload } | { ok: false; error: EventErrorCode };
  switch (operation) {
    case 'output:subscribe':
    case 'output:unsubscribe':
    case 'output:resync': parsed = parseSubscriptionPayload(payloadRead.value); break;
    case 'conversation:submit':
    case 'conversation:queue':
    case 'conversation:steer': parsed = parseConversationPayload(payloadRead.value); break;
    case 'attention:reply': parsed = parseAttentionReplyPayload(payloadRead.value); break;
    case 'agent:spawn': parsed = parseSpawnPayload(payloadRead.value); break;
    case 'agent:steer':
    case 'agent:resume': parsed = parseAgentMessageTargetPayload(payloadRead.value); break;
    case 'agent:stop': parsed = parseAgentTargetPayload(payloadRead.value); break;
    case 'history:recent': parsed = parseHistoryRecentPayload(payloadRead.value); break;
    case 'history:result': parsed = parseHistoryResultPayload(payloadRead.value); break;
  }
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      identity: identityFrom(client.value, request.value, session.value, epoch.value, operation),
    };
  }
  payload = parsed.value;

  const requestDto = {
    version: EVENTS_INTEGRATIONS_VERSION,
    clientId: client.value,
    requestId: request.value,
    ownerSessionId: session.value,
    ownerEpoch: epoch.value,
    operation,
    payload,
  } as EventRequestV1;

  if (executableStringByteCount(requestDto) > EVENT_LIMITS.executableStringBytes) {
    return {
      ok: false,
      error: 'CAPACITY',
      identity: identityFrom(client.value, request.value, session.value, epoch.value, operation),
    };
  }
  return { ok: true, value: requestDto };
}

/** Parses the metadata owner envelope. Unknown additive fields are ignored. */
export function parseOwnerEpochEnvelope(value: unknown): EventParseResult<OwnerEpochEnvelopeV1> {
  if (!isObject(value)) return { ok: false, error: 'INVALID_REQUEST' };
  const versionRead = readProperty(value, 'version');
  if (versionRead.kind !== 'value' || versionRead.value !== EVENTS_INTEGRATIONS_VERSION) {
    return { ok: false, error: versionRead.kind === 'value' && typeof versionRead.value === 'number' ? 'UNSUPPORTED_API' : 'INVALID_REQUEST' };
  }
  const session = requiredString(value, 'ownerSessionId', isIdentifier);
  const epoch = requiredString(value, 'ownerEpoch', isIdentifier);
  if (!session.ok) return { ok: false, error: 'INVALID_REQUEST' };
  if (!epoch.ok) return { ok: false, error: 'STALE_OWNER' };
  return { ok: true, value: { version: EVENTS_INTEGRATIONS_VERSION, ownerSessionId: session.value, ownerEpoch: epoch.value } };
}

/**
 * Canonical semantics for idempotency. Only validated, allowlisted fields
 * participate. Operation is explicit, and caller/request identifiers are not
 * part of the semantic fingerprint.
 */
export function canonicalEventRequest(request: EventRequestV1): string {
  switch (request.operation) {
    case 'output:subscribe':
    case 'output:unsubscribe':
    case 'output:resync':
      return JSON.stringify({ operation: request.operation, payload: { subscriptionId: request.payload.subscriptionId } });
    case 'conversation:submit':
    case 'conversation:queue':
    case 'conversation:steer':
      return JSON.stringify({ operation: request.operation, payload: { text: request.payload.text } });
    case 'attention:reply':
      return JSON.stringify({ operation: request.operation, payload: { attentionId: request.payload.attentionId, answer: request.payload.answer } });
    case 'agent:spawn':
      return JSON.stringify({ operation: request.operation, payload: { tasks: request.payload.tasks.map(task => ({ task: task.task, model: task.model, thinking: task.thinking })) } });
    case 'agent:steer':
    case 'agent:resume':
      return JSON.stringify({ operation: request.operation, payload: { runId: request.payload.runId, expectedStartedAt: request.payload.expectedStartedAt, message: request.payload.message } });
    case 'agent:stop':
      return JSON.stringify({ operation: request.operation, payload: { runId: request.payload.runId, expectedStartedAt: request.payload.expectedStartedAt } });
    case 'history:recent':
      return JSON.stringify({ operation: request.operation, payload: { limit: request.payload.limit, cursor: request.payload.cursor } });
    case 'history:result':
      return JSON.stringify({ operation: request.operation, payload: { runId: request.payload.runId, expectedStartedAt: request.payload.expectedStartedAt } });
  }
}

/** The raw UTF-8 size of a string, exported for adapters that project text. */
export function utf8TextBytes(value: string): number {
  return utf8Bytes(value);
}
