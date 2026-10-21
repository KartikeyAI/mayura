import { utf8ByteLength } from '@mayura/core/host';
import { freezeJson, jsonValue, MayuraError, type JsonValue, type ModelHistoryMessage } from '@mayura/core';

/** Most messages a history may hold; its size is bounded by the run's context limit too. */
export const MAX_HISTORY_MESSAGES = 2_048;
const callIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const toolIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function invalid(detail: string): never { throw new MayuraError('INVALID_INPUT', `The run's history is not a valid conversation: ${detail}`); }

/**
 * A run's history as frozen, checked data: whole turns, oldest first. Every tool call is answered by its result, in the
 * order called, before the next message; call ids are unique; no turn is left open. History carries no media in this
 * release, so a message with media is refused rather than sent without it.
 */
export function admitHistory(raw: unknown, maxBytes: number): readonly ModelHistoryMessage[] {
  if (!Array.isArray(raw)) invalid('it must be an array of messages.');
  if (raw.length > MAX_HISTORY_MESSAGES) invalid(`it holds more than ${MAX_HISTORY_MESSAGES} messages.`);
  let copy: JsonValue;
  try { copy = freezeJson(jsonValue(raw, { maxBytes })); }
  catch { return invalid('it must be plain JSON within the run\'s context limit (limits.maxContextBytes).'); }
  const messages = copy as unknown as readonly Record<string, unknown>[];
  const seen = new Set<string>();
  let pending: { id: string; toolId: string }[] = [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) invalid(`message ${index} is not an object.`);
    const keys = Object.keys(message).sort().join(',');
    if (Object.hasOwn(message, 'media')) invalid(`message ${index} has media, which history does not carry yet.`);
    if (message['role'] === 'user') {
      if (keys !== 'content,role') invalid(`message ${index} (user) must have exactly role and content.`);
      if (pending.length) invalid(`message ${index} comes before tool call ${pending[0]!.id} has its result.`);
      return;
    }
    if (message['role'] === 'assistant') {
      if (pending.length) invalid(`message ${index} comes before tool call ${pending[0]!.id} has its result.`);
      if (keys === 'output,role') return;
      if (keys !== 'calls,role' || !Array.isArray(message['calls']) || message['calls'].length === 0) {
        invalid(`message ${index} (assistant) must have either output or a non-empty list of calls.`);
      }
      for (const call of message['calls'] as readonly Record<string, unknown>[]) {
        if (!call || typeof call !== 'object' || Object.keys(call).sort().join(',') !== 'id,input,toolId'
          || typeof call['id'] !== 'string' || !callIdPattern.test(call['id']) || typeof call['toolId'] !== 'string' || !toolIdPattern.test(call['toolId'])) {
          invalid(`message ${index} has a tool call without a valid id, toolId and input.`);
        }
        if (seen.has(call['id'] as string)) invalid(`tool call id ${call['id'] as string} is used twice.`);
        seen.add(call['id'] as string);
      }
      pending = (message['calls'] as readonly { id: string; toolId: string }[]).map(call => ({ id: call.id, toolId: call.toolId }));
      return;
    }
    if (message['role'] === 'tool') {
      if (keys !== 'callId,result,role,toolId') invalid(`message ${index} (tool) must have exactly role, callId, toolId and result.`);
      const next = pending.shift();
      if (!next || next.id !== message['callId'] || next.toolId !== message['toolId']) invalid(`message ${index} is a tool result that answers no open call, or answers out of order.`);
      return;
    }
    invalid(`message ${index} has an unknown role.`);
  });
  if (pending.length) invalid(`it ends before tool call ${pending[0]!.id} has its result.`);
  return messages as unknown as readonly ModelHistoryMessage[];
}


/** History messages, optionally accompanied by bounded fitting metadata from a thread service. */
export type RunHistory = readonly ModelHistoryMessage[] | {
  readonly messages: readonly ModelHistoryMessage[];
  /** Complete turns omitted by the caller's history fitter; informational, never an authorization proof. */
  readonly omittedTurns: number;
  readonly scanTruncated?: boolean;
};

/** Snapshot structural thread history without forwarding its summaries, IDs, timestamps or other metadata. */
export function admitRunHistory(raw: unknown, maxBytes: number) {
  let supplied = raw; let omitted = 0; let scanTruncated = false;
  if (!Array.isArray(raw)) {
    try {
      if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error();
      const fields = Object.getOwnPropertyDescriptors(raw);
      if (Reflect.ownKeys(fields).length > 8 || Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !('value' in fields[key]!))) throw new Error();
      if (!fields['messages'] || !fields['omittedTurns']) throw new Error();
      supplied = fields['messages'].value;
      const count: unknown = fields['omittedTurns'].value;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error();
      omitted = count;
      const truncated: unknown = fields['scanTruncated']?.value;
      if (truncated !== undefined && typeof truncated !== 'boolean') throw new Error();
      scanTruncated = truncated === true;
    } catch { return invalid('history metadata requires messages, a bounded omitted-turn count and an optional scan flag.'); }
  }
  const messages = admitHistory(supplied, maxBytes);
  return Object.freeze({ messages, metadata: Object.freeze({ entries: messages.length, omitted, bytes: utf8ByteLength(JSON.stringify(messages)), scanTruncated }) });
}
