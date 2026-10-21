import { toolContinuation } from '@mayura/tools/host';
import { freezeJson, jsonValue, MayuraError, MEDIA_TYPES, type JsonObject, type JsonValue, type Media, type MediaType, type ModelMessage, type ModelToolCall, type Scope } from '@mayura/core';
import { fromBase64Url, sha256Hex, toBase64Url } from '@mayura/core/host';
import type { RecordedApproval } from './recording.js';
import { isIdentifier, type AgentDefinition } from './agent.js';

/** A saved checkpoint, as the runtime reads it back. `store.runCheckpoints` of any Mayura store fits. */
export interface StoredRunCheckpoint {
  readonly runId: string;
  readonly scope: string;
  readonly status: string;
  readonly leaseExpiresAtMs?: number | null;
  readonly expiresAtMs: number;
  readonly body: JsonObject;
}
/** The part of a run-checkpoint store the runtime uses. `store.runCheckpoints` of any Mayura store fits. */
export interface RunCheckpointPort {
  put(command: { readonly runId: string; readonly scope: string; readonly expiresAtMs: number; readonly body: JsonObject }): Promise<unknown>;
  get(command: { readonly runId: string }): Promise<StoredRunCheckpoint | undefined>;
  claim(command: { readonly runId: string; readonly holderId: string; readonly leaseMs: number; readonly expectedDigest?: string }): Promise<unknown>;
  delete(command: { readonly runId: string; readonly holderId?: string; readonly expectedVersion?: number; readonly expectedDigest?: string }): Promise<boolean>;
  due(command: { readonly expiresBeforeMs: number; readonly limit: number }): Promise<readonly string[]>;
}
/** Where runs waiting for approval are saved, so they survive a restart and any replica can resume them. */
export interface CheckpointOptions {
  /** `store.runCheckpoints` of a Mayura store (call its `initialize()` first). */
  readonly store: RunCheckpointPort;
  /** Agents this runtime may resume when it did not start the run itself, for example after a restart. */
  readonly agents?: readonly AgentDefinition[];
  /** This runtime's name when it holds a checkpoint (default: a random id). */
  readonly replicaId?: string;
  /** How long a hold on a checkpoint lasts while the run resumes (default 30 seconds, 1 second to 1 hour). */
  readonly leaseMs?: number;
  /** Let a host recovery worker own expiry instead of starting process-local timers (default true). */
  readonly autoExpire?: boolean;
}
export interface ResolvedCheckpoints {
  readonly store: RunCheckpointPort;
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  readonly replicaId: string;
  readonly leaseMs: number;
  readonly autoExpire: boolean;
}

export function checkpointOptions(supplied: CheckpointOptions | undefined): ResolvedCheckpoints | undefined {
  if (supplied === undefined) return undefined;
  const fail = (detail: string): never => { throw new MayuraError('INVALID_CONFIG', `checkpoints: ${detail}`); };
  if (typeof supplied !== 'object' || supplied === null) return fail('pass { store, agents?, replicaId?, leaseMs? }.');
  if (Object.keys(supplied).some(key => !['store', 'agents', 'replicaId', 'leaseMs', 'autoExpire'].includes(key))) fail('takes only store, agents, replicaId, leaseMs and autoExpire.');
  if (supplied.autoExpire !== undefined && typeof supplied.autoExpire !== 'boolean') fail('autoExpire must be a boolean.');
  const store = supplied.store;
  if (!store || ['put', 'get', 'claim', 'delete', 'due'].some(method => typeof (store as unknown as Record<string, unknown>)[method] !== 'function')) {
    fail('store must be a run-checkpoint store, such as store.runCheckpoints.');
  }
  const agents = new Map<string, AgentDefinition>();
  for (const agent of supplied.agents ?? []) {
    if (!agent || typeof agent !== 'object' || !isIdentifier(agent.id)) fail('agents must be agent definitions.');
    if (agents.has(agent.id)) fail(`agent ${agent.id} is listed twice.`);
    agents.set(agent.id, agent);
  }
  const replicaId = supplied.replicaId ?? crypto.randomUUID();
  if (!isIdentifier(replicaId)) fail('replicaId must be a short identifier.');
  const leaseMs = supplied.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) fail('leaseMs must be 1000 to 3600000.');
  return Object.freeze({ store, agents, replicaId, leaseMs, autoExpire: supplied.autoExpire !== false });
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
/** The checkpoint key for a scope: fixed length, so any principal and project ids fit the store's bound. */
export function scopeKey(scope: Scope): string {
  return sha256Hex(`mayura:run-scope:v1\0${scope.principalId}\0${scope.projectId}`);
}
const ids = (items: readonly { readonly id?: unknown }[]): JsonValue[] => items.map(item => typeof item.id === 'string' ? item.id : null);
/**
 * What a resumed run must find unchanged in its agent: identity, instructions, model, tools and their policies, guards,
 * hooks, streaming and schemas. A deploy that changes any of them while a run waits means the run cannot continue.
 */
export function agentDigest(agent: AgentDefinition, memo = new Map<AgentDefinition, string>()): string {
  const cached = memo.get(agent); if (cached) return cached;
  const shape: JsonValue = {
    id: agent.id, version: agent.version, instructions: agent.instructions,
    ...((agent.handoffs?.length ?? 0) > 0 ? { handoffs: agent.handoffs!.map(edge => ({ id: edge.agent.id,
      digest: agentDigest(edge.agent, memo), permissions: [...edge.permissions.allow], description: edge.description ?? null })) } : {}),
    model: { id: agent.model.id, maxCostMicros: agent.model.maxCostMicros },
    tools: agent.tools.map(tool => ({ id: tool.id, version: tool.version, effects: tool.effects, capabilities: [...tool.capabilities],
      costMicros: tool.costMicros, approval: tool.approval ?? null, ...(toolContinuation(tool) ? { continuation: 'external-result-v1' } : {}) })),
    guards: { input: ids(agent.guards.input), output: ids(agent.guards.output) },
    hooks: agent.hooks.map(hook => ({ id: hook.id, version: hook.version, stage: hook.stage })),
    stream: agent.stream ? [...agent.stream.field] : null,
    input: agent.inputJsonSchema ?? null, output: agent.outputJsonSchema ?? null,
    media: agent.media ? jsonValue(agent.media) : null,
  };
  const digest = sha256Hex(`mayura:agent-definition:v1\0${canonical(shape)}`); memo.set(agent, digest); return digest;
}

function encodeMedia(items: readonly Media[]): JsonValue[] {
  return items.map(item => ({ mediaType: item.mediaType, ...('data' in item ? { data: toBase64Url(item.data) } : { url: item.url }),
    ...(item.name === undefined ? {} : { name: item.name }) }));
}
/** A run's messages as JSON: media bytes as base64url, so a checkpoint holds them exactly. */
export function encodeMessages(messages: readonly ModelMessage[]): JsonValue[] {
  return messages.map(message => {
    const media = 'media' in message && message.media && message.media.length > 0 ? { media: encodeMedia(message.media) } : {};
    if (message.role === 'user') return { role: 'user', content: message.content, ...media };
    if (message.role === 'assistant') return { role: 'assistant', calls: message.calls.map(call => ({ id: call.id, toolId: call.toolId, input: call.input })) };
    return { role: 'tool', callId: message.callId, toolId: message.toolId, result: message.result, ...media };
  });
}

function corrupt(): never { throw new MayuraError('STORAGE_UNAVAILABLE', 'The run checkpoint is not one this runtime can resume.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) corrupt();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string') corrupt(); return value as string; }
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) corrupt(); return value as number; }
function decodeMedia(raw: unknown): Media[] {
  if (!Array.isArray(raw)) corrupt();
  return (raw as unknown[]).map(entry => {
    const item = record(entry); const mediaType = text(item['mediaType']) as MediaType;
    if (!MEDIA_TYPES.includes(mediaType)) corrupt();
    const name = item['name'] === undefined ? {} : { name: text(item['name']) };
    if (typeof item['url'] === 'string') return Object.freeze({ type: 'media' as const, mediaType, url: item['url'], ...name });
    const data = fromBase64Url(text(item['data'])); if (!data) corrupt();
    return Object.freeze({ type: 'media' as const, mediaType, data: data!, ...name });
  });
}
function decodeCall(raw: unknown): ModelToolCall {
  const call = record(raw);
  if (!isIdentifier(call['toolId']) || typeof call['id'] !== 'string') corrupt();
  return { id: call['id'] as string, toolId: call['toolId'] as string, input: (call['input'] ?? null) as JsonValue };
}
export function decodeMessages(raw: unknown): ModelMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) corrupt();
  return (raw as unknown[]).map(entry => {
    const message = record(entry);
    const media = message['media'] === undefined ? {} : { media: Object.freeze(decodeMedia(message['media'])) };
    if (message['role'] === 'user') return { role: 'user' as const, content: (message['content'] ?? null) as JsonValue, ...media };
    if (message['role'] === 'assistant') {
      if (!Array.isArray(message['calls'])) corrupt();
      return { role: 'assistant' as const, calls: (message['calls'] as unknown[]).map(decodeCall) };
    }
    if (message['role'] === 'tool') return { role: 'tool' as const, callId: text(message['callId']), toolId: text(message['toolId']), result: (message['result'] ?? null) as JsonValue, ...media };
    return corrupt();
  });
}

/** A run paused for approval, as saved: everything needed to continue it exactly where it stopped. */
export interface CheckpointBody {
  /** External frontend waits are distinct from human approval and can never be answered by approve(). */
  readonly waitKind?: 'frontend';
  /** Schema-admitted input with input guards completed before external publication. */
  readonly preparedInput?: JsonValue;
  /** Declared frontend cost/call conservatively settled before publication; consumption cannot charge it again. */
  readonly prepaid?: true;
  /** Port result identity, distinct from the runtime-owned checkpoint epoch digest. */
  readonly externalDigest?: string;
  readonly handoff?: { readonly path: readonly string[]; readonly sourcePermissions: readonly string[] };
  readonly recording?: JsonObject;
  readonly approvals?: readonly RecordedApproval[];
  readonly agent: { readonly id: string; readonly version: string; readonly digest: string };
  readonly scope: Scope;
  readonly permissions: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly input: JsonValue;
  readonly history: JsonValue | null;
  readonly messages: readonly ModelMessage[];
  readonly continuation: JsonValue | null;
  readonly step: number;
  /** The calls of the paused batch still to run, the one waiting for approval first. */
  readonly calls: readonly ModelToolCall[];
  readonly callIds: readonly string[];
  readonly counts: { readonly modelCalls: number; readonly toolCalls: number; readonly hookCalls: number; readonly descendants: number };
  readonly spent: { readonly micros: string; readonly calls: number };
  readonly receipts: readonly JsonValue[];
  readonly mediaBytes: number;
  /** Active time left for the run: waiting does not count against maxDurationMs. */
  readonly remainingMs: number;
  readonly pending: { readonly callId: string; readonly toolId: string; readonly toolVersion: string; readonly input: JsonValue;
    readonly digest: string; readonly expiresAtMs: number; readonly onExpired: 'reject' | 'cancel' };
}

export function encodeBody(body: CheckpointBody): JsonObject {
  return freezeJson(jsonValue({ format: 1, ...body, messages: encodeMessages(body.messages),
    calls: body.calls.map(call => ({ id: call.id, toolId: call.toolId, input: call.input })) })) as JsonObject;
}
/** Read a stored body back, refusing anything malformed rather than resuming from it. */
export function decodeBody(raw: JsonObject): CheckpointBody {
  const body = record(raw);
  if (body['format'] !== 1 || (body['waitKind'] !== undefined && body['waitKind'] !== 'frontend')) corrupt();
  if (body['waitKind'] === 'frontend' && (!Object.hasOwn(body, 'preparedInput') || body['prepaid'] !== true
    || typeof body['externalDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(body['externalDigest']))) corrupt();
  const agent = record(body['agent']); const scope = record(body['scope']); const pending = record(body['pending']);
  const counts = record(body['counts']); const spent = record(body['spent']); const limits = record(body['limits']);
  if (!Array.isArray(body['permissions']) || (body['permissions'] as unknown[]).some(grant => typeof grant !== 'string')) corrupt();
  if (!Array.isArray(body['calls']) || !Array.isArray(body['callIds']) || !Array.isArray(body['receipts'])) corrupt();
  if (Object.values(limits).some(value => !Number.isSafeInteger(value))) corrupt();
  if (pending['onExpired'] !== 'reject' && pending['onExpired'] !== 'cancel') corrupt();
  if (typeof spent['micros'] !== 'string' || !/^[0-9]{1,30}$/u.test(spent['micros'])) corrupt();
  const calls = (body['calls'] as unknown[]).map(decodeCall);
  if (calls.length === 0 || calls[0]!.id !== pending['callId']) corrupt();
  const handoff = body['handoff'] === undefined ? undefined : record(body['handoff']);
  if (handoff && (!Array.isArray(handoff['path']) || handoff['path'].length < 1 || handoff['path'].length > 64
    || handoff['path'].some(id => !isIdentifier(id)) || !Array.isArray(handoff['sourcePermissions']) || handoff['sourcePermissions'].length > 4096
    || handoff['sourcePermissions'].some(grant => typeof grant !== 'string' || !grant.length || grant.length > 256))) corrupt();
  const recording = body['recording'] === undefined ? undefined : record(body['recording']) as JsonObject;
  if (recording && new TextEncoder().encode(JSON.stringify(recording)).length > 4096) corrupt();
  const approvals = body['approvals'];
  if (approvals !== undefined && (!Array.isArray(approvals) || approvals.length > 4096 || approvals.some(raw => {
    const approval = record(raw);
    return typeof approval['callId'] !== 'string' || typeof approval['toolId'] !== 'string'
      || !['approved', 'rejected', 'expired'].includes(approval['decision'] as string)
      || (approval['actorId'] !== undefined && typeof approval['actorId'] !== 'string');
  }))) corrupt();
  return {
    ...(body['waitKind'] === 'frontend' ? { waitKind: 'frontend' as const, prepaid: true as const, externalDigest: body['externalDigest'] as string, preparedInput: jsonValue(body['preparedInput'] ?? null) } : {}),
    ...(handoff ? { handoff: { path: handoff['path'] as string[], sourcePermissions: handoff['sourcePermissions'] as string[] } } : {}),
    ...(recording ? { recording, approvals: (approvals ?? []) as unknown as readonly RecordedApproval[] } : {}),
    agent: { id: text(agent['id']), version: text(agent['version']), digest: text(agent['digest']) },
    scope: { principalId: text(scope['principalId']), projectId: text(scope['projectId']) },
    permissions: body['permissions'] as string[], limits: limits as Record<string, number>,
    input: (body['input'] ?? null) as JsonValue, history: (body['history'] ?? null) as JsonValue,
    messages: decodeMessages(body['messages']), continuation: (body['continuation'] ?? null) as JsonValue,
    step: count(body['step']), calls, callIds: (body['callIds'] as unknown[]).map(text),
    counts: { modelCalls: count(counts['modelCalls']), toolCalls: count(counts['toolCalls']), hookCalls: count(counts['hookCalls']), descendants: count(counts['descendants']) },
    spent: { micros: spent['micros'] as string, calls: count(spent['calls']) },
    receipts: body['receipts'] as JsonValue[], mediaBytes: count(body['mediaBytes']), remainingMs: count(body['remainingMs']),
    pending: { callId: text(pending['callId']), toolId: text(pending['toolId']), toolVersion: text(pending['toolVersion']),
      input: (pending['input'] ?? null) as JsonValue, digest: text(pending['digest']), expiresAtMs: count(pending['expiresAtMs']),
      onExpired: pending['onExpired'] as 'reject' | 'cancel' },
  };
}
