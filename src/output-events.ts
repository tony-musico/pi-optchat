/**
 * Opt-in, bounded assistant-output events for trusted in-process extensions.
 *
 * Only assistant text is projected. Raw messages, partial state, reasoning,
 * tool calls, arguments, usage, provider errors, and prompt text are never
 * retained or published by this module.
 */
import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import {
  EVENT_LIMITS,
  OUTPUT_EVENT,
  OUTPUT_SUBSCRIBE_EVENT,
  OUTPUT_UNSUBSCRIBE_EVENT,
  isIdentifier,
  parseEventRequest,
  type EventErrorCode,
  type EventRequestV1,
  type OutputEventKindV1,
  type OutputEventV1,
} from './events-contract.ts';

export interface OutputEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface OutputEventTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface OutputEventsOptions {
  readonly bus: OutputEventBus;
  readonly ownerSessionId: string;
  readonly ownerEpoch: string;
  readonly contentEnabled: boolean;
  /** The owner's generated activity id, or null outside an activity. */
  readonly turnId: () => string | null;
  readonly now?: () => number;
  readonly timer?: OutputEventTimer;
  readonly idFactory?: () => string;
}

export interface OutputEvents {
  messageStart(message: AgentMessage): void;
  messageUpdate(event: AssistantMessageEvent): void;
  messageEnd(message: AgentMessage): void;
  settled(aborted: boolean): void;
  dispose(): void;
}

const defaultTimer: OutputEventTimer = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
  },
};

const LEASE_MS = 5 * 60 * 1000;
const MAX_SUBSCRIPTIONS = EVENT_LIMITS.outputSubscriptions;
const MAX_QUEUED_DELTA_BYTES = EVENT_LIMITS.queuedDeltaBytes;
const MAX_RETAINED_MESSAGES = EVENT_LIMITS.retainedMessages;
const MAX_RETAINED_MESSAGE_BYTES = EVENT_LIMITS.retainedMessageBytes;
const MAX_RECOVERY_BYTES = EVENT_LIMITS.recoveryCacheBytes;

interface Subscription {
  readonly clientId: string;
  readonly subscriptionId: string;
  expiresAt: number;
  sequence: number;
  queued: string;
  queuedBytes: number;
  queuedTurnId: string | null;
  queuedMessageId: string | null;
  nextFlushAt: number | undefined;
  gapPending: boolean;
}

interface RetainedMessage {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly text: string;
  readonly truncated: boolean;
  readonly snapshotId: string;
}

interface ActiveMessage {
  readonly messageId: string;
  readonly turnId: string | null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maximum: number): { text: string; truncated: boolean } {
  if (utf8Bytes(value) <= maximum) return { text: value, truncated: false };
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const size = utf8Bytes(character);
    if (bytes + size > maximum) break;
    characters.push(character);
    bytes += size;
  }
  return { text: characters.join(''), truncated: true };
}

function splitUtf8(value: string, maximum: number): string[] {
  if (!value) return [''];
  const chunks: string[] = [];
  let characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const size = utf8Bytes(character);
    if (bytes + size > maximum) {
      chunks.push(characters.join(''));
      characters = [];
      bytes = 0;
    }
    characters.push(character);
    bytes += size;
  }
  if (characters.length) chunks.push(characters.join(''));
  return chunks;
}

function takePrefix(value: string, maximum: number): { prefix: string; rest: string } {
  const characters: string[] = [];
  const restCharacters: string[] = [];
  let bytes = 0;
  let rest = false;
  for (const character of value) {
    if (!rest) {
      const size = utf8Bytes(character);
      if (bytes + size > maximum) rest = true;
      else {
        characters.push(character);
        bytes += size;
        continue;
      }
    }
    restCharacters.push(character);
  }
  return { prefix: characters.join(''), rest: restCharacters.join('') };
}

/** Project only allowlisted assistant text blocks without assembling the full source. */
function assistantText(message: AssistantMessage): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let bytes = 0;
  let hasText = false;
  let truncated = false;

  for (const block of message.content) {
    if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) continue;
    if (hasText) {
      if (bytes + 1 > MAX_RETAINED_MESSAGE_BYTES) {
        truncated = true;
        break;
      }
      parts.push('\n');
      bytes += 1;
    }
    let chunk = '';
    for (const character of block.text) {
      const size = utf8Bytes(character);
      if (bytes + size > MAX_RETAINED_MESSAGE_BYTES) {
        truncated = true;
        break;
      }
      chunk += character;
      bytes += size;
    }
    if (chunk) {
      parts.push(chunk);
      hasText = true;
    }
    if (truncated) break;
  }

  return { text: parts.join(''), truncated };
}

/** Create the bounded output publisher and attach its request listeners. */
export function createOutputEvents(options: OutputEventsOptions): OutputEvents {
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? defaultTimer;
  const idFactory = options.idFactory ?? randomUUID;
  const subscriptions = new Map<string, Subscription>();
  const retained: RetainedMessage[] = [];
  let retainedBytes = 0;
  let recoveryGap = false;
  let activeMessage: ActiveMessage | undefined;
  let lastTurnId: string | null = null;
  let activityFailed = false;
  let disposed = false;
  let timerHandle: unknown;
  let timerDue: number | undefined;

  const generatedId = (): string => {
    const candidate = idFactory();
    return isIdentifier(candidate) ? candidate : randomUUID();
  };

  const emit = (event: OutputEventV1): void => {
    try { options.bus.emit(OUTPUT_EVENT, Object.freeze(event)); }
    catch { /* subscriber failures never escape or expose payload text */ }
  };

  const event = (
    target: { clientId: string; subscriptionId: string; sequence: number },
    fields: {
      kind: OutputEventKindV1;
      requestId?: string | null;
      turnId?: string | null;
      messageId?: string | null;
      text?: string;
      truncated?: boolean;
      gap?: boolean;
      replacement?: boolean;
      snapshotId?: string | null;
      snapshotIndex?: number | null;
      snapshotCount?: number | null;
      errorCode?: EventErrorCode | null;
    },
  ): void => {
    const text = fields.text ?? '';
    const bounded = truncateUtf8(text, EVENT_LIMITS.outputEventBytes);
    emit(Object.freeze({
      version: 1,
      ownerSessionId: options.ownerSessionId,
      ownerEpoch: options.ownerEpoch,
      clientId: target.clientId,
      subscriptionId: target.subscriptionId,
      requestId: fields.requestId ?? null,
      turnId: fields.turnId ?? null,
      messageId: fields.messageId ?? null,
      sequence: target.sequence,
      kind: fields.kind,
      text: bounded.text,
      truncated: fields.truncated === true || bounded.truncated,
      gap: fields.gap === true,
      replacement: fields.replacement === true,
      snapshotId: fields.snapshotId ?? null,
      snapshotIndex: fields.snapshotIndex ?? null,
      snapshotCount: fields.snapshotCount ?? null,
      errorCode: fields.errorCode ?? null,
    }));
  };

  const emitTo = (subscription: Subscription, fields: Parameters<typeof event>[1]): void => {
    subscription.sequence++;
    event(subscription, fields);
  };

  const emitEphemeral = (clientId: string, subscriptionId: string, requestId: string, code: EventErrorCode): void => {
    event({ clientId, subscriptionId, sequence: 1 }, {
      kind: 'rejected',
      requestId,
      errorCode: code,
    });
  };

  const clearSubscriptionQueue = (subscription: Subscription): void => {
    subscription.queued = '';
    subscription.queuedBytes = 0;
    subscription.queuedTurnId = null;
    subscription.queuedMessageId = null;
  };

  const emitGap = (subscription: Subscription, requestId: string | null = null): void => {
    emitTo(subscription, { kind: 'gap', requestId, gap: true });
  };

  const emitFinal = (subscription: Subscription, message: RetainedMessage, requestId: string | null = null): void => {
    const chunks = splitUtf8(message.text, EVENT_LIMITS.outputEventBytes);
    for (let index = 0; index < chunks.length; index++) {
      emitTo(subscription, {
        kind: 'final',
        requestId,
        turnId: message.turnId,
        messageId: message.messageId,
        text: chunks[index],
        truncated: message.truncated,
        replacement: true,
        snapshotId: message.snapshotId,
        snapshotIndex: index,
        snapshotCount: chunks.length,
      });
    }
  };

  const replayRecovery = (subscription: Subscription, requestId: string | null = null): void => {
    if (recoveryGap) emitGap(subscription, requestId);
    for (const message of retained) emitFinal(subscription, message, requestId);
  };

  const cancelTimer = (): void => {
    if (timerHandle !== undefined) {
      try { timer.clear(timerHandle); } catch { /* best effort */ }
      timerHandle = undefined;
      timerDue = undefined;
    }
  };

  const nextDue = (): number | undefined => {
    let due: number | undefined;
    for (const subscription of subscriptions.values()) {
      due = due === undefined ? subscription.expiresAt : Math.min(due, subscription.expiresAt);
      if (subscription.nextFlushAt !== undefined) {
        due = due === undefined ? subscription.nextFlushAt : Math.min(due, subscription.nextFlushAt);
      }
    }
    return due;
  };

  const schedule = (): void => {
    if (disposed) return;
    const due = nextDue();
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
        for (const [key, subscription] of [...subscriptions]) {
          if (subscription.expiresAt <= current) {
            subscriptions.delete(key);
            clearSubscriptionQueue(subscription);
            continue;
          }
          if (subscription.nextFlushAt !== undefined && subscription.nextFlushAt <= current) {
            subscription.nextFlushAt = undefined;
            if (subscription.gapPending) {
              subscription.gapPending = false;
              clearSubscriptionQueue(subscription);
              emitGap(subscription);
            } else if (subscription.queued) {
              const { prefix, rest } = takePrefix(subscription.queued, EVENT_LIMITS.outputEventBytes);
              const turnId = subscription.queuedTurnId;
              const messageId = subscription.queuedMessageId;
              subscription.queued = rest;
              subscription.queuedBytes = utf8Bytes(rest);
              if (!rest) {
                subscription.queuedTurnId = null;
                subscription.queuedMessageId = null;
              }
              emitTo(subscription, { kind: 'text_delta', turnId, messageId, text: prefix });
              if (rest) subscription.nextFlushAt = current + EVENT_LIMITS.outputBatchIntervalMs;
            }
          }
        }
        schedule();
      }, Math.max(0, due - at));
    } catch {
      timerHandle = undefined;
      timerDue = undefined;
    }
  };

  const queueDelta = (delta: string, turnId: string | null, messageId: string | null): void => {
    if (disposed || !options.contentEnabled || !delta) return;
    const bytes = utf8Bytes(delta);
    for (const subscription of subscriptions.values()) {
      if (subscription.queued && (subscription.queuedTurnId !== turnId || subscription.queuedMessageId !== messageId)) {
        subscription.gapPending = true;
        clearSubscriptionQueue(subscription);
      }
      if (bytes > MAX_QUEUED_DELTA_BYTES || subscription.queuedBytes + bytes > MAX_QUEUED_DELTA_BYTES) {
        subscription.gapPending = true;
        clearSubscriptionQueue(subscription);
      } else {
        if (!subscription.queued) {
          subscription.queuedTurnId = turnId;
          subscription.queuedMessageId = messageId;
        }
        subscription.queued += delta;
        subscription.queuedBytes += bytes;
      }
      if (subscription.nextFlushAt === undefined) {
        subscription.nextFlushAt = now() + EVENT_LIMITS.outputBatchIntervalMs;
      }
    }
    schedule();
  };

  const clearQueued = (): void => {
    for (const subscription of subscriptions.values()) {
      clearSubscriptionQueue(subscription);
      subscription.nextFlushAt = undefined;
    }
  };

  const retain = (message: RetainedMessage): void => {
    retained.push(message);
    retainedBytes += utf8Bytes(message.text);
    while (retained.length > MAX_RETAINED_MESSAGES || retainedBytes > MAX_RECOVERY_BYTES) {
      const removed = retained.shift();
      if (!removed) break;
      retainedBytes -= utf8Bytes(removed.text);
      recoveryGap = true;
    }
    if (message.truncated) recoveryGap = true;
  };

  const rejectRequest = (request: EventRequestV1, code: EventErrorCode): void => {
    let subscriptionId = 'invalid';
    if ('subscriptionId' in request.payload) subscriptionId = request.payload.subscriptionId;
    emitEphemeral(request.clientId, subscriptionId, request.requestId, code);
  };

  const handleRequest = (value: unknown, expected: 'subscribe' | 'unsubscribe'): void => {
    try {
      const parsed = parseEventRequest(value);
      if (!parsed.ok) return;
      const request = parsed.value;
      const allowed = expected === 'subscribe'
        ? request.operation === 'output:subscribe' || request.operation === 'output:resync'
        : request.operation === 'output:unsubscribe';
      if (!allowed) { rejectRequest(request, 'INVALID_REQUEST'); return; }
      if (!options.contentEnabled) { rejectRequest(request, 'DISABLED'); return; }
      if (request.ownerEpoch !== options.ownerEpoch || request.ownerSessionId !== options.ownerSessionId) {
        rejectRequest(request, 'STALE_OWNER');
        return;
      }
      if (!('subscriptionId' in request.payload)) { rejectRequest(request, 'INVALID_REQUEST'); return; }
      const subscriptionId = request.payload.subscriptionId;
      if (request.operation === 'output:subscribe') {
        const existing = subscriptions.get(subscriptionId);
        if (existing) {
          if (existing.clientId !== request.clientId) { rejectRequest(request, 'REQUEST_CONFLICT'); return; }
          existing.expiresAt = now() + LEASE_MS;
          emitTo(existing, { kind: 'subscribed', requestId: request.requestId });
          schedule();
          return;
        }
        if (subscriptions.size >= MAX_SUBSCRIPTIONS) { rejectRequest(request, 'CAPACITY'); return; }
        const subscription: Subscription = {
          clientId: request.clientId,
          subscriptionId,
          expiresAt: now() + LEASE_MS,
          sequence: 0,
          queued: '',
          queuedBytes: 0,
          queuedTurnId: null,
          queuedMessageId: null,
          nextFlushAt: undefined,
          gapPending: false,
        };
        subscriptions.set(subscriptionId, subscription);
        emitTo(subscription, { kind: 'subscribed', requestId: request.requestId });
        replayRecovery(subscription);
        schedule();
        return;
      }
      if (request.operation === 'output:unsubscribe') {
        const existing = subscriptions.get(subscriptionId);
        if (existing && existing.clientId !== request.clientId) { rejectRequest(request, 'REQUEST_CONFLICT'); return; }
        if (existing) {
          emitTo(existing, { kind: 'unsubscribed', requestId: request.requestId });
          subscriptions.delete(subscriptionId);
        } else {
          event({ clientId: request.clientId, subscriptionId, sequence: 1 }, {
            kind: 'unsubscribed',
            requestId: request.requestId,
          });
        }
        schedule();
        return;
      }
      const existing = subscriptions.get(subscriptionId);
      if (!existing || existing.clientId !== request.clientId) { rejectRequest(request, 'NOT_FOUND'); return; }
      replayRecovery(existing, request.requestId);
    } catch {
      // Malformed or hostile request traffic is ignored.
    }
  };

  const stopSubscribe = options.bus.on(OUTPUT_SUBSCRIBE_EVENT, value => handleRequest(value, 'subscribe'));
  const stopUnsubscribe = options.bus.on(OUTPUT_UNSUBSCRIBE_EVENT, value => handleRequest(value, 'unsubscribe'));

  return {
    messageStart(message) {
      if (disposed || !options.contentEnabled || message.role !== 'assistant') return;
      if (activeMessage) recoveryGap = true;
      activeMessage = { messageId: generatedId(), turnId: options.turnId() };
      lastTurnId = activeMessage.turnId;
    },
    messageUpdate(update) {
      if (disposed || !options.contentEnabled || update.type !== 'text_delta' || typeof update.delta !== 'string') return;
      if (!activeMessage) {
        activeMessage = { messageId: generatedId(), turnId: options.turnId() };
        lastTurnId = activeMessage.turnId;
        recoveryGap = true;
      }
      queueDelta(update.delta, activeMessage.turnId, activeMessage.messageId);
    },
    messageEnd(message) {
      if (disposed || !options.contentEnabled || message.role !== 'assistant') return;
      if (!activeMessage) {
        activeMessage = { messageId: generatedId(), turnId: options.turnId() };
        lastTurnId = activeMessage.turnId;
        recoveryGap = true;
      }
      const projected = assistantText(message);
      const retainedMessage: RetainedMessage = {
        messageId: activeMessage.messageId,
        turnId: activeMessage.turnId,
        text: projected.text,
        truncated: projected.truncated,
        snapshotId: generatedId(),
      };
      retain(retainedMessage);
      clearQueued();
      for (const subscription of subscriptions.values()) {
        if (subscription.gapPending) {
          subscription.gapPending = false;
          emitGap(subscription);
        }
        emitFinal(subscription, retainedMessage);
      }
      if (message.stopReason === 'error') activityFailed = true;
      activeMessage = undefined;
    },
    settled(aborted) {
      if (disposed || !options.contentEnabled) return;
      if (activeMessage) recoveryGap = true;
      activeMessage = undefined;
      const kind: OutputEventKindV1 = aborted ? 'aborted' : activityFailed ? 'failed' : 'completed';
      const errorCode: EventErrorCode | null = kind === 'failed' ? 'INTERNAL_ERROR' : null;
      for (const subscription of subscriptions.values()) {
        emitTo(subscription, { kind, turnId: lastTurnId, errorCode });
      }
      activityFailed = false;
      lastTurnId = null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      try { stopSubscribe(); } catch { /* best effort */ }
      try { stopUnsubscribe(); } catch { /* best effort */ }
      subscriptions.clear();
      retained.length = 0;
      retainedBytes = 0;
      activeMessage = undefined;
      lastTurnId = null;
      activityFailed = false;
    },
  };
}
