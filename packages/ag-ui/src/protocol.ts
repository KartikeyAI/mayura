import { freezeJson, jsonValue } from '@mayura/core';
import type { ClientJson } from '@mayura/client';

/** Wire subset implemented by this entry point; not a claim of full SDK conformance. */
export const AG_UI_PROTOCOL_VERSION = '1.0' as const;
export interface AgUiToolCall {
  readonly id: string; readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}
export type AgUiContentPart = { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image' | 'document'; readonly source: { readonly type: 'file'; readonly value: string; readonly provider: 'mayura'; readonly mimeType: string } };
/** Opaque file handles only. No byte data or remote URLs are accepted or fetched.
 * Incoming messages are UI echoes, never trusted model history. */
export type AgUiMessage =
  | { readonly id: string; readonly role: 'user'; readonly content: string | readonly AgUiContentPart[] }
  | { readonly id: string; readonly role: 'assistant'; readonly content?: string; readonly toolCalls?: readonly AgUiToolCall[] }
  | { readonly id: string; readonly role: 'tool'; readonly toolCallId: string; readonly content: string; readonly error?: string };
export type AgUiResume =
  | { readonly interruptId: string; readonly status: 'resolved'; readonly payload: { readonly approved: boolean } }
  | { readonly interruptId: string; readonly status: 'cancelled' };
/** Producer-owned state; client echoes never become native input or patches. */
export type AgUiState = ClientJson;
/** Generated RFC 6902 subset. Arrays are replaced atomically; object paths use RFC 6901 escaping. */
export type AgUiStatePatchOperation =
  | { readonly op: 'add' | 'replace'; readonly path: string; readonly value: AgUiState }
  | { readonly op: 'remove'; readonly path: string };
export interface AgUiStateMetadata {
  readonly mayura: { readonly stateRevision: number; readonly previousStateRevision?: number };
}
export interface AgUiFrontendTool {
  readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, ClientJson>>;
}
export interface AgUiFrontendContinuation { readonly token: string; readonly claimId: string }
export interface AgUiFrontendDispatchMetadata {
  readonly mayura: { readonly frontend: { readonly token: string; readonly expiresAtMs: number; readonly claimPath: string } };
}
export interface AgUiRunInput {
  readonly threadId: string; readonly runId: string; readonly messages: readonly AgUiMessage[];
  readonly protocolVersion?: typeof AG_UI_PROTOCOL_VERSION;
  readonly state?: AgUiState;
  readonly tools?: readonly AgUiFrontendTool[];
  readonly forwardedProps?: { readonly mayuraFrontend: AgUiFrontendContinuation };
  readonly resume?: readonly AgUiResume[];
}
export interface AgUiInterrupt {
  readonly id: string; readonly reason: 'tool_call'; readonly toolCallId: string; readonly expiresAt: string;
  readonly message: string; readonly responseSchema: Readonly<Record<string, ClientJson>>;
}
/** AG-UI 1.0 event fields. Provider diagnostics, raw events and native receipts are never forwarded. */
export type AgUiEvent = { readonly timestamp?: number } & (
  | { readonly type: 'RUN_STARTED'; readonly threadId: string; readonly runId: string; readonly metadata: { readonly mayura: { readonly runId: string } } }
  | { readonly type: 'RUN_FINISHED'; readonly threadId: string; readonly runId: string;
      readonly outcome: { readonly type: 'success'; readonly pendingToolCallIds?: readonly string[] } | { readonly type: 'cancelled' } | { readonly type: 'interrupt'; readonly interrupts: readonly AgUiInterrupt[] } }
  | { readonly type: 'CUSTOM'; readonly name: string; readonly value: ClientJson }
  | { readonly type: 'RUN_ERROR'; readonly message: string; readonly code: string }
  | { readonly type: 'STATE_SNAPSHOT'; readonly snapshot: AgUiState; readonly metadata: AgUiStateMetadata }
  | { readonly type: 'STATE_DELTA'; readonly delta: readonly AgUiStatePatchOperation[]; readonly metadata: AgUiStateMetadata }
  | { readonly type: 'MESSAGES_SNAPSHOT'; readonly messages: readonly AgUiMessage[] }
  | { readonly type: 'STEP_STARTED' | 'STEP_FINISHED'; readonly stepName: string }
  | { readonly type: 'TEXT_MESSAGE_START'; readonly messageId: string; readonly role: 'assistant' }
  | { readonly type: 'TEXT_MESSAGE_CONTENT'; readonly messageId: string; readonly delta: string }
  | { readonly type: 'TEXT_MESSAGE_END'; readonly messageId: string }
  | { readonly type: 'TOOL_CALL_START'; readonly toolCallId: string; readonly toolCallName: string; readonly parentMessageId: string; readonly metadata?: AgUiFrontendDispatchMetadata }
  | { readonly type: 'TOOL_CALL_ARGS'; readonly toolCallId: string; readonly delta: string }
  | { readonly type: 'TOOL_CALL_END'; readonly toolCallId: string }
  | { readonly type: 'TOOL_CALL_RESULT'; readonly messageId: string; readonly toolCallId: string; readonly content: string; readonly role: 'tool' }
);

/** Internal sanitized failure: its code is safe on the wire; exception messages are not. */
export class AgUiFailure extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgUiFailure('INVALID_INPUT');
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new AgUiFailure('UNSUPPORTED_INPUT');
  }
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) throw new AgUiFailure('INVALID_ID');
  return value;
}
/** Strict copying precedes inspection so getters, unsafe numbers and prototype keys cannot become commands. */
export function boundedJson(value: unknown, maxBytes: number): ClientJson {
  try { return freezeJson(jsonValue(value, { maxBytes, maxDepth: 32, maxNodes: 100_000 })); }
  catch { throw new AgUiFailure('JSON_LIMIT'); }
}
export function readInput(value: unknown, maxBytes: number, maxMessages: number, stateEnabled = false, frontendEnabled = false, mediaEnabled = false): AgUiRunInput {
  const raw = object(boundedJson(value, maxBytes));
  fields(raw, ['threadId', 'runId', 'messages'], ['protocolVersion', 'resume', 'tools', 'context', 'state', 'forwardedProps']);
  identifier(raw['threadId']); identifier(raw['runId']);
  if (raw['protocolVersion'] !== undefined && raw['protocolVersion'] !== AG_UI_PROTOCOL_VERSION) throw new AgUiFailure('UNSUPPORTED_PROTOCOL');
  // State echoes are admitted only with a host source and never dispatched as input, permissions or patches.
  if (raw['context'] !== undefined && (!Array.isArray(raw['context']) || raw['context'].length !== 0)) throw new AgUiFailure('UNSUPPORTED_INPUT');
  if (!stateEnabled && raw['state'] !== undefined && Object.keys(object(raw['state'])).length !== 0) throw new AgUiFailure('UNSUPPORTED_INPUT');
  if (raw['tools'] !== undefined) {
    if (!Array.isArray(raw['tools']) || raw['tools'].length > (frontendEnabled ? 128 : 0)) throw new AgUiFailure('UNSUPPORTED_INPUT');
    const names = new Set<string>();
    for (const value of raw['tools'] as unknown[]) {
      const tool = object(value); fields(tool, ['name', 'description', 'parameters']); const name = identifier(tool['name']);
      if (names.has(name) || typeof tool['description'] !== 'string' || tool['description'].length > 4096) throw new AgUiFailure('INVALID_FRONTEND_TOOL');
      names.add(name); object(tool['parameters']);
    }
  }
  let continuation: Record<string, unknown> | undefined;
  if (raw['forwardedProps'] !== undefined) {
    const forwarded = object(raw['forwardedProps']);
    if (frontendEnabled && Object.hasOwn(forwarded, 'mayuraFrontend')) {
      fields(forwarded, ['mayuraFrontend']); continuation = object(forwarded['mayuraFrontend']); fields(continuation, ['token', 'claimId']);
      if ([continuation['token'], continuation['claimId']].some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))) throw new AgUiFailure('INVALID_FRONTEND_CONTINUATION');
    } else if (Object.keys(forwarded).length !== 0) throw new AgUiFailure('UNSUPPORTED_INPUT');
  }
  if (!Array.isArray(raw['messages']) || raw['messages'].length > maxMessages) throw new AgUiFailure('MESSAGE_LIMIT');
  const ids = new Set<string>();
  for (const item of raw['messages'] as unknown[]) {
    const message = object(item); const id = identifier(message['id']);
    if (ids.has(id)) throw new AgUiFailure('DUPLICATE_MESSAGE'); ids.add(id);
    switch (message['role']) {
      case 'user':
        fields(message, ['id', 'role', 'content']);
        if (Array.isArray(message['content'])) {
          if (!mediaEnabled || message['content'].length > 33) throw new AgUiFailure('UNSUPPORTED_MEDIA');
          for (const item of message['content']) {
            const part = object(item);
            if (part['type'] === 'text') { fields(part, ['type', 'text']); if (typeof part['text'] !== 'string') throw new AgUiFailure('INVALID_MESSAGE'); }
            else {
              fields(part, ['type', 'source']); const source = object(part['source']); fields(source, ['type', 'value', 'provider', 'mimeType']);
              if (!['image', 'document'].includes(String(part['type'])) || source['type'] !== 'file' || source['provider'] !== 'mayura'
                || typeof source['value'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(source['value'])
                || !(part['type'] === 'document' ? source['mimeType'] === 'application/pdf' : ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(source['mimeType'])))) throw new AgUiFailure('UNSUPPORTED_MEDIA');
            }
          }
        }
        break;
      case 'assistant':
        fields(message, ['id', 'role'], ['content', 'toolCalls']);
        if (message['content'] === undefined && message['toolCalls'] === undefined) throw new AgUiFailure('INVALID_MESSAGE');
        if (message['toolCalls'] !== undefined) {
          if (!Array.isArray(message['toolCalls']) || message['toolCalls'].length > 256) throw new AgUiFailure('MESSAGE_LIMIT');
          for (const call of message['toolCalls'] as unknown[]) {
            const tool = object(call); fields(tool, ['id', 'type', 'function']); identifier(tool['id']);
            const fn = object(tool['function']); fields(fn, ['name', 'arguments']); identifier(fn['name']);
            if (tool['type'] !== 'function' || typeof fn['arguments'] !== 'string') throw new AgUiFailure('INVALID_MESSAGE');
          }
        }
        break;
      case 'tool': fields(message, ['id', 'role', 'toolCallId', 'content'], ['error']); identifier(message['toolCallId']);
        if (message['error'] !== undefined && (typeof message['error'] !== 'string' || message['error'].length > 1000)) throw new AgUiFailure('INVALID_FRONTEND_RESULT');
        break;
      default: throw new AgUiFailure('UNSUPPORTED_MESSAGE');
    }
    if (message['content'] !== undefined && typeof message['content'] !== 'string' && !(message['role'] === 'user' && Array.isArray(message['content']))) throw new AgUiFailure('UNSUPPORTED_MESSAGE');
  }
  if (raw['resume'] !== undefined && (!Array.isArray(raw['resume']) || raw['resume'].length > 1)) throw new AgUiFailure('UNSUPPORTED_RESUME');
  if (continuation && Array.isArray(raw['resume']) && raw['resume'].length) throw new AgUiFailure('AMBIGUOUS_CONTINUATION');
  if (Array.isArray(raw['resume']) && raw['resume'].length === 1) {
    const resume = object(raw['resume'][0]);
    if (typeof resume['interruptId'] !== 'string' || resume['interruptId'].length > 4096) throw new AgUiFailure('INVALID_INTERRUPT');
    if (resume['status'] === 'resolved') {
      fields(resume, ['interruptId', 'status', 'payload']); const payload = object(resume['payload']); fields(payload, ['approved']);
      if (typeof payload['approved'] !== 'boolean') throw new AgUiFailure('INVALID_APPROVAL');
    } else if (resume['status'] === 'cancelled') fields(resume, ['interruptId', 'status']);
    else throw new AgUiFailure('INVALID_APPROVAL');
  } else if (continuation) {
    if (raw['messages'].length !== 1 || object(raw['messages'][0])['role'] !== 'tool') throw new AgUiFailure('FRONTEND_RESULT_REQUIRED');
  } else {
    const last = raw['messages'].at(-1) as Record<string, unknown> | undefined;
    if (last?.['role'] !== 'user' || !(typeof last['content'] === 'string' ? last['content'].trim() : Array.isArray(last['content']) && last['content'].some(part => part.type === 'text' && part.text?.trim()))) throw new AgUiFailure('USER_MESSAGE_REQUIRED');
  }
  return Object.freeze({ threadId: raw['threadId'], runId: raw['runId'], messages: raw['messages'],
    ...(raw['protocolVersion'] === undefined ? {} : { protocolVersion: raw['protocolVersion'] }),
    ...(raw['state'] === undefined ? {} : { state: raw['state'] as AgUiState }),
    ...(raw['tools'] === undefined ? {} : { tools: raw['tools'] }),
    ...(continuation === undefined ? {} : { forwardedProps: { mayuraFrontend: continuation } }),
    ...(!Array.isArray(raw['resume']) || raw['resume'].length === 0 ? {} : { resume: raw['resume'] }) }) as unknown as AgUiRunInput;
}
