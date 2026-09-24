import {
  assertSchema, freezeJson, jsonValue, MayuraError, validate,
  type InferInput, type InferOutput, type JsonObject, type JsonValue, type Schema, type Scope,
} from '@mayura/core';
import type { AggregateStore } from '@mayura/storage-contracts';
import { createWorkStream, type SignalRecord, type WaitSnapshot, type WorkStream } from './index.js';

export type HumanRequestKind = 'information' | 'correction' | 'plan_selection';

export interface HumanRequestDefinition<S extends Schema = Schema> {
  readonly id: string;
  readonly kind: HumanRequestKind;
  /** Stable application-owned name for the response schema. */
  readonly schemaId: string;
  /** SHA-256 of the pinned schema artifact or application schema contract. */
  readonly schemaDigest: string;
  readonly prompt: string;
  readonly response: S;
  readonly context?: JsonValue;
  /** Mandatory for corrections; binds the request to the exact candidate being corrected. */
  readonly subjectDigest?: string;
  /** Absolute Unix epoch deadline. */
  readonly deadlineAtMs?: number;
}

export interface HumanActor {
  /** Verified application identity. Claims and credentials are never persisted by this facade. */
  readonly id: string;
}

export interface HumanAuthorizationInput {
  readonly action: 'respond';
  readonly actor: HumanActor;
  readonly scope: Scope;
  readonly request: HumanRequestMetadata;
}

export interface HumanRequestMetadata {
  readonly id: string;
  readonly kind: HumanRequestKind;
  readonly schemaId: string;
  readonly schemaDigest: string;
  readonly prompt: string;
  readonly context?: JsonValue;
  readonly subjectDigest?: string;
  readonly deadlineAtMs?: number;
  readonly digest: string;
}

export interface HumanResponse<T = JsonValue> {
  readonly commandId: string;
  readonly actorId: string;
  readonly value: T;
  readonly digest: string;
}

export interface HumanRequestSnapshot<T = JsonValue> {
  readonly request: HumanRequestMetadata;
  readonly status: 'waiting' | 'answered' | 'cancelled' | 'timed_out';
  readonly response: HumanResponse<T> | null;
}

export interface HumanWorkStreamOptions {
  readonly store: AggregateStore;
  readonly scope: Scope;
  readonly streamId: string;
  /** Authorizes an already-authenticated actor. Rejection and exceptions are safely collapsed. */
  readonly authorize: (input: HumanAuthorizationInput, signal: AbortSignal) => boolean | Promise<boolean>;
  readonly now?: () => number;
  readonly callbackTimeoutMs?: number;
}

export interface HumanWorkStream {
  initialize(): Promise<void>;
  request<S extends Schema>(definition: HumanRequestDefinition<S>): Promise<HumanRequestSnapshot<InferOutput<S>>>;
  inspect<S extends Schema>(definition: HumanRequestDefinition<S>): Promise<HumanRequestSnapshot<InferOutput<S>> | undefined>;
  respond<S extends Schema>(definition: HumanRequestDefinition<S>, command: {
    readonly commandId: string;
    readonly actor: HumanActor;
    readonly value: InferInput<S>;
  }): Promise<HumanRequestSnapshot<InferOutput<S>>>;
  cancel(id: string): Promise<HumanRequestSnapshot>;
  sweepDeadlines(options?: { readonly limit?: number }): Promise<readonly HumanRequestSnapshot[]>;
}

interface PersistedRequest extends JsonObject {
  format: 1;
  id: string;
  kind: HumanRequestKind;
  schemaId: string;
  schemaDigest: string;
  prompt: string;
  context?: JsonValue;
  subjectDigest?: string;
  deadlineAtMs?: number;
  digest: string;
}

interface PersistedResponse extends JsonObject {
  format: 1;
  requestDigest: string;
  commandId: string;
  actorId: string;
  value: JsonValue;
  digest: string;
}

const REQUEST_BYTES = 3_584;
const RESPONSE_BYTES = 3_584;
const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function invalid(message = 'Human request input is invalid.'): never { throw new MayuraError('INVALID_INPUT', message); }
function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) invalid(`${label} must be a bounded simple identifier.`);
}
function actorId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) invalid('Actor identity is invalid.');
}
function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !digestPattern.test(value)) invalid(`${label} must be a lowercase SHA-256 digest.`);
}
function timestamp(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('Human request deadline is invalid.');
}
function object(value: JsonValue): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
function immutable<T>(value: T): T { return freezeJson(jsonValue(value)) as unknown as T; }
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
async function sha256(domain: string, value: JsonValue): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}\0${canonical(value)}`));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function waitId(id: string): string { return `hrq.${id}`; }
function requestSignalId(id: string): string { return `human-request.${id}`; }
function responseSignalId(id: string): string { return `human-response.${id}`; }
function responseSignalName(id: string): string { return `human.response.${id}`; }

function currentClock(now: () => number): number {
  let value: unknown;
  try { value = now(); } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'The trusted human-request clock is unavailable.'); }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MayuraError('STORAGE_UNAVAILABLE', 'The trusted human-request clock returned an invalid timestamp.');
  return value;
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, failure: MayuraError): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure); }, timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function captured<S extends Schema>(definition: HumanRequestDefinition<S>): Promise<{ readonly metadata: HumanRequestMetadata; readonly persisted: PersistedRequest }> {
  assertSchema(definition.response);
  identifier(definition.id, 'Request ID'); identifier(definition.schemaId, 'Schema ID');
  if (!['information', 'correction', 'plan_selection'].includes(definition.kind)) invalid('Human request kind is invalid.');
  digest(definition.schemaDigest, 'Schema digest');
  if (typeof definition.prompt !== 'string' || definition.prompt.length < 1 || new TextEncoder().encode(definition.prompt).length > 1_024) invalid('Human request prompt must contain 1–1024 UTF-8 bytes.');
  if (definition.subjectDigest !== undefined) digest(definition.subjectDigest, 'Subject digest');
  if (definition.kind === 'correction' && definition.subjectDigest === undefined) invalid('Correction requests must bind an exact subject digest.');
  if (definition.kind !== 'correction' && definition.subjectDigest !== undefined) invalid('Only correction requests may include a subject digest.');
  if (definition.deadlineAtMs !== undefined) timestamp(definition.deadlineAtMs);
  const material = jsonValue({ format: 1, id: definition.id, kind: definition.kind, schemaId: definition.schemaId,
    schemaDigest: definition.schemaDigest, prompt: definition.prompt,
    ...(definition.context === undefined ? {} : { context: definition.context }),
    ...(definition.subjectDigest === undefined ? {} : { subjectDigest: definition.subjectDigest }),
    ...(definition.deadlineAtMs === undefined ? {} : { deadlineAtMs: definition.deadlineAtMs }),
  }, { maxBytes: REQUEST_BYTES }) as JsonObject;
  const requestDigest = await sha256('mayura:human-request:v1', material);
  const persisted = freezeJson(jsonValue({ ...material, digest: requestDigest }, { maxBytes: REQUEST_BYTES })) as PersistedRequest;
  return { persisted, metadata: publicMetadata(persisted) };
}

function persistedRequest(value: JsonValue): PersistedRequest {
  const item = object(jsonValue(value, { maxBytes: REQUEST_BYTES }));
  const allowed = ['format', 'id', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'context', 'subjectDigest', 'deadlineAtMs', 'digest'];
  if (Object.keys(item).some(key => !allowed.includes(key)) || item['format'] !== 1) invalid('Stored human request failed integrity validation.');
  identifier(item['id'], 'Request ID'); identifier(item['schemaId'], 'Schema ID'); digest(item['schemaDigest'], 'Schema digest'); digest(item['digest'], 'Request digest');
  if (!['information', 'correction', 'plan_selection'].includes(item['kind'] as string) || typeof item['prompt'] !== 'string'
    || item['prompt'].length < 1 || new TextEncoder().encode(item['prompt']).length > 1_024) invalid('Stored human request failed integrity validation.');
  if (item['subjectDigest'] !== undefined) digest(item['subjectDigest'], 'Subject digest');
  if ((item['kind'] === 'correction') !== (item['subjectDigest'] !== undefined)) invalid('Stored human request failed integrity validation.');
  if (item['deadlineAtMs'] !== undefined) timestamp(item['deadlineAtMs']);
  return freezeJson(item) as PersistedRequest;
}

async function persistedResponse(value: JsonValue, requestDigest: string): Promise<PersistedResponse> {
  const item = object(jsonValue(value, { maxBytes: RESPONSE_BYTES }));
  if (Object.keys(item).some(key => !['format', 'requestDigest', 'commandId', 'actorId', 'value', 'digest'].includes(key)) || item['format'] !== 1 || !Object.hasOwn(item, 'value')) invalid('Stored human response failed integrity validation.');
  digest(item['requestDigest'], 'Request digest'); digest(item['digest'], 'Response digest'); identifier(item['commandId'], 'Command ID'); actorId(item['actorId']);
  if (item['requestDigest'] !== requestDigest) throw new MayuraError('INTEGRITY_VIOLATION', 'Human response is bound to another request.');
  const material = jsonValue({ format: 1, requestDigest: item['requestDigest'], commandId: item['commandId'], actorId: item['actorId'], value: item['value'] }, { maxBytes: RESPONSE_BYTES });
  if (await sha256('mayura:human-response:v1', material) !== item['digest']) throw new MayuraError('INTEGRITY_VIOLATION', 'Human response digest does not match its content.');
  return freezeJson(item) as PersistedResponse;
}

function publicMetadata(request: PersistedRequest): HumanRequestMetadata {
  return immutable({ id: request.id, kind: request.kind, schemaId: request.schemaId, schemaDigest: request.schemaDigest,
    prompt: request.prompt, ...(request.context === undefined ? {} : { context: request.context }),
    ...(request.subjectDigest === undefined ? {} : { subjectDigest: request.subjectDigest }),
    ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }), digest: request.digest });
}

async function signals(stream: WorkStream): Promise<readonly SignalRecord[]> {
  const result: SignalRecord[] = []; let after = 0;
  while (true) {
    const page = await stream.signals({ after, limit: 100 }); result.push(...page.items);
    if (page.items.length < 100) return result;
    if (page.next <= after) throw new MayuraError('INTEGRITY_VIOLATION', 'Human request signal pagination did not advance.');
    after = page.next;
  }
}

/** Durable typed human requests over the bounded WorkStream journal. */
export function createHumanWorkStream(options: HumanWorkStreamOptions): HumanWorkStream {
  if (typeof options.authorize !== 'function') throw new MayuraError('INVALID_CONFIG', 'Human requests require an explicit authorization callback.');
  const timeoutMs = options.callbackTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new MayuraError('INVALID_CONFIG', 'Human callback timeout must be between 1 and 30000 milliseconds.');
  const now = options.now ?? Date.now;
  const stream = createWorkStream({ store: options.store, scope: options.scope, streamId: options.streamId, now });
  const scope = immutable<Scope>({ principalId: options.scope.principalId, projectId: options.scope.projectId });

  const findRequest = async (id: string): Promise<PersistedRequest | undefined> => {
    const signal = (await signals(stream)).find(item => item.id === requestSignalId(id));
    if (!signal) return undefined;
    if (signal.name !== `human.request.${id}`) throw new MayuraError('INTEGRITY_VIOLATION', 'Human request signal identity is invalid.');
    const saved = persistedRequest(signal.value);
    const savedMaterial = jsonValue(Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'digest')) as JsonObject);
    if (await sha256('mayura:human-request:v1', savedMaterial) !== saved.digest) throw new MayuraError('INTEGRITY_VIOLATION', 'Human request metadata changed or does not match its digest.');
    return saved;
  };
  const checked = async <S extends Schema>(definition: HumanRequestDefinition<S>): Promise<{ metadata: HumanRequestMetadata; wait: WaitSnapshot } | undefined> => {
    const expected = await captured(definition); const saved = await findRequest(definition.id);
    if (!saved) return undefined;
    if (saved.digest !== expected.metadata.digest) throw new MayuraError('INTEGRITY_VIOLATION', 'Human request metadata changed or does not match its digest.');
    const wait = await stream.inspect(waitId(definition.id));
    if (!wait) throw new MayuraError('INTEGRITY_VIOLATION', 'Human request is missing its durable wait.');
    const expectedWait = { id: waitId(definition.id), mode: 'all', conditions: [{ id: 'response', name: responseSignalName(definition.id), after: 0 }],
      ...(definition.deadlineAtMs === undefined ? {} : { deadlineAtMs: definition.deadlineAtMs }) };
    const actualWait = { id: wait.id, mode: wait.mode, conditions: wait.conditions,
      ...(wait.deadlineAtMs === undefined ? {} : { deadlineAtMs: wait.deadlineAtMs }) };
    if (canonical(jsonValue(actualWait)) !== canonical(jsonValue(expectedWait))) throw new MayuraError('INTEGRITY_VIOLATION', 'Human request wait identity is invalid.');
    return { metadata: publicMetadata(saved), wait };
  };
  const snapshot = async <T>(metadata: HumanRequestMetadata, wait: WaitSnapshot): Promise<HumanRequestSnapshot<T>> => {
    if (wait.status !== 'succeeded') return immutable<HumanRequestSnapshot<T>>({ request: metadata, status: wait.status, response: null });
    if (wait.matches.length !== 1 || wait.matches[0]?.conditionId !== 'response'
      || wait.matches[0].signal.id !== responseSignalId(metadata.id) || wait.matches[0].signal.name !== responseSignalName(metadata.id)) throw new MayuraError('INTEGRITY_VIOLATION', 'Human request wait has an invalid response match.');
    const response = await persistedResponse(wait.matches[0].signal.value, metadata.digest);
    return immutable<HumanRequestSnapshot<T>>({ request: metadata, status: 'answered', response: { commandId: response.commandId, actorId: response.actorId, value: response.value as T, digest: response.digest } });
  };

  return Object.freeze<HumanWorkStream>({
    initialize: () => stream.initialize(),
    request: async <S extends Schema>(definition: HumanRequestDefinition<S>) => {
      const { persisted, metadata } = await captured(definition);
      await stream.signal({ id: requestSignalId(definition.id), name: `human.request.${definition.id}`, value: persisted });
      let wait = await stream.register({ id: waitId(definition.id), mode: 'all', conditions: [{ id: 'response', name: responseSignalName(definition.id) }],
        ...(definition.deadlineAtMs === undefined ? {} : { deadlineAtMs: definition.deadlineAtMs }) });
      if (wait.status === 'waiting' && definition.deadlineAtMs !== undefined && currentClock(now) >= definition.deadlineAtMs) {
        await stream.sweepDeadlines({ limit: 128 });
        wait = await stream.inspect(waitId(definition.id)) ?? wait;
      }
      return snapshot<InferOutput<S>>(metadata, wait);
    },
    inspect: async <S extends Schema>(definition: HumanRequestDefinition<S>) => {
      const found = await checked(definition); return found ? snapshot<InferOutput<S>>(found.metadata, found.wait) : undefined;
    },
    respond: async <S extends Schema>(definition: HumanRequestDefinition<S>, command: { readonly commandId: string; readonly actor: HumanActor; readonly value: InferInput<S> }) => {
      identifier(command.commandId, 'Command ID'); actorId(command.actor?.id);
      const found = await checked(definition);
      if (!found) throw new MayuraError('NOT_FOUND', 'Human request was not found in this stream.');
      const authorized = await bounded(signal => Promise.resolve(options.authorize(immutable<HumanAuthorizationInput>({ action: 'respond', actor: { id: command.actor.id }, scope, request: found.metadata }), signal)), timeoutMs,
        new MayuraError('PERMISSION_DENIED', 'Human response authorization was not confirmed.')).catch(() => false);
      if (authorized !== true) throw new MayuraError('PERMISSION_DENIED', 'Human response authorization was not confirmed.');
      if (found.wait.status === 'cancelled' || found.wait.status === 'timed_out') return snapshot<InferOutput<S>>(found.metadata, found.wait);
      if (found.metadata.deadlineAtMs !== undefined && currentClock(now) >= found.metadata.deadlineAtMs) {
        await stream.sweepDeadlines({ limit: 128 });
        const expired = await stream.inspect(waitId(definition.id));
        if (!expired) throw new MayuraError('INTEGRITY_VIOLATION', 'Human request is missing its durable wait.');
        return snapshot<InferOutput<S>>(found.metadata, expired);
      }
      const value = freezeJson(jsonValue(await bounded(() => validate(definition.response, command.value, 'input', { maxBytes: RESPONSE_BYTES }), timeoutMs,
        new MayuraError('INVALID_INPUT', 'Human response validation did not complete within its limit.')), { maxBytes: RESPONSE_BYTES }));
      const material = jsonValue({ format: 1, requestDigest: found.metadata.digest, commandId: command.commandId, actorId: command.actor.id, value }, { maxBytes: RESPONSE_BYTES });
      const responseDigest = await sha256('mayura:human-response:v1', material);
      if (found.wait.status === 'succeeded') {
        const existing = await snapshot<InferOutput<S>>(found.metadata, found.wait);
        if (existing.response?.digest !== responseDigest) throw new MayuraError('CONFLICT', 'Human request already has a different response.');
        return existing;
      }
      await stream.signal({ id: responseSignalId(definition.id), name: responseSignalName(definition.id), value: { ...object(material), digest: responseDigest } });
      const resolved = await stream.inspect(waitId(definition.id));
      if (!resolved) throw new MayuraError('INTEGRITY_VIOLATION', 'Human request is missing its durable wait.');
      return snapshot<InferOutput<S>>(found.metadata, resolved);
    },
    cancel: async id => {
      identifier(id, 'Request ID'); const metadata = await findRequest(id);
      if (!metadata) throw new MayuraError('NOT_FOUND', 'Human request was not found in this stream.');
      return snapshot(publicMetadata(metadata), await stream.cancel(waitId(id)));
    },
    sweepDeadlines: async input => {
      const expired = await stream.sweepDeadlines(input); const result: HumanRequestSnapshot[] = [];
      for (const wait of expired) {
        if (!wait.id.startsWith('hrq.')) continue;
        const metadata = await findRequest(wait.id.slice(4));
        if (!metadata) throw new MayuraError('INTEGRITY_VIOLATION', 'Expired human wait is missing its request metadata.');
        result.push(await snapshot(publicMetadata(metadata), wait));
      }
      return Object.freeze(result);
    },
  });
}
