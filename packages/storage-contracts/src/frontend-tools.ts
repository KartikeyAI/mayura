import { freezeJson, jsonValue, MayuraError, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import { sha256Hex, toBase64Url } from '@mayura/core/host';
import { StorageError, type AggregateStore, type StoredRecord } from './contracts.js';

/** Immutable host registration fingerprint; executable behavior changes require a new version. */
export interface FrontendToolRegistration { readonly id: string; readonly version: string; readonly digest: string }
/** Scoped native-run binding. Retrying bind must preserve identity and cannot extend its deadline. */
export interface FrontendToolBinding {
  readonly scope: Scope; readonly agentId: string; readonly runId: string; readonly threadId: string;
  readonly tools: readonly FrontendToolRegistration[]; readonly expiresAtMs: number;
}
/** Untrusted normalized browser result, committed atomically with settlement and retained for reconciliation. */
export interface FrontendToolResultOutbox {
  readonly requestDigest: string; readonly continuationRunId: string; readonly value: JsonValue; readonly failed: boolean;
  readonly acceptedAtMs: number; readonly consumerId: string | null; readonly reservedAtMs: number | null;
}
/** Monotonic durable call: pending -> claimed -> settled. Purging redacts payloads without resetting state. */
export interface FrontendToolCallRecord {
  readonly scope: Scope; readonly agentId: string; readonly runId: string; readonly threadId: string;
  readonly token: string; readonly callId: string; readonly toolId: string; readonly toolVersion: string; readonly definitionDigest: string;
  readonly input: JsonValue; readonly inputDigest: string; readonly expiresAtMs: number; readonly retainUntilMs: number;
  readonly status: 'pending' | 'claimed' | 'settled'; readonly dispatchedRunId: string | null; readonly claimId: string | null;
  /** Recoverable calls cannot dispatch until their native checkpoint is committed. */
  readonly waitState?: 'prepared' | 'parked';
  readonly outbox: FrontendToolResultOutbox | null; readonly purged: boolean;
}
export interface FrontendToolStoreKey { readonly scope: Scope; readonly agentId: string; readonly token: string; readonly signal?: AbortSignal }
/** Shared CAS journal. Claims and delivery reservations never expire back into an executable state. */
export interface FrontendToolStore {
  /** Bind once before registration; conflicting advertisements, scope or thread identities fail closed. */
  bind(binding: FrontendToolBinding, signal?: AbortSignal): Promise<void>;
  binding(scope: Scope, agentId: string, runId: string, signal?: AbortSignal): Promise<FrontendToolBinding | null>;
  /** Pin one stable token per native call before creating an executable pending record. */
  register(input: { readonly scope: Scope; readonly agentId: string; readonly runId: string; readonly callId: string; readonly toolId: string;
    readonly toolVersion: string; readonly definitionDigest: string; readonly input: JsonValue; readonly timeoutMs: number; readonly retentionMs: number; readonly recoverable?: boolean; readonly signal?: AbortSignal }): Promise<FrontendToolCallRecord>;
  calls(scope: Scope, agentId: string, runId: string, signal?: AbortSignal): Promise<readonly FrontendToolCallRecord[]>;
  read(key: FrontendToolStoreKey): Promise<FrontendToolCallRecord | null>;
  /** Arm a prepared call after its native continuation checkpoint is durably saved. */
  park?(key: FrontendToolStoreKey): Promise<FrontendToolCallRecord>;
  dispatch(key: FrontendToolStoreKey, externalRunId: string): Promise<FrontendToolCallRecord>;
  /** One-shot admission; even a lost commit reply never permits a second browser execution. */
  claim(key: FrontendToolStoreKey, claimId: string): Promise<FrontendToolCallRecord>;
  /** Commit the immutable outbox before acknowledgment. Only identical result commands are idempotent. */
  accept(key: FrontendToolStoreKey, input: { readonly claimId: string; readonly threadId: string; readonly continuationRunId: string;
    readonly requestDigest: string; readonly value: JsonValue; readonly failed: boolean }): Promise<FrontendToolCallRecord>;
  /** Permanent reservation, not proof of native output validation or terminal thread recording. Never transferred. */
  reserveResult(key: FrontendToolStoreKey, consumerId: string): Promise<FrontendToolCallRecord>;
  /** Redact expired content while retaining non-executable claim/result tombstones and stable call identity. */
  purgeExpired(scope: Scope, agentId: string, runId: string, signal?: AbortSignal): Promise<number>;
}
export interface AggregateFrontendToolStoreOptions {
  readonly permissions: { readonly allow: readonly string[] };
  readonly limits?: { readonly maxCallsPerRun?: number; readonly maxRecordBytes?: number; readonly maxAttempts?: number };
}
interface Slot { readonly token: string; readonly callId: string; readonly toolId: string; readonly toolVersion: string; readonly definitionDigest: string;
  readonly inputDigest: string; readonly expiresAtMs: number; readonly retainUntilMs: number }
interface RunState { readonly format: 1; readonly kind: 'frontend.run'; readonly binding: FrontendToolBinding; readonly slots: readonly Slot[] }
const hash = (value: unknown): string => {
  const canonical = (item: any): string => item === null || typeof item !== 'object' ? JSON.stringify(item) : Array.isArray(item)
    ? `[${item.map(canonical).join(',')}]` : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
  return sha256Hex(canonical(value));
};
const format = sha256Hex('mayura.frontend-tools.v1');
function bad(): never { throw new MayuraError('STORAGE_UNAVAILABLE', 'Frontend tool journal integrity failed.'); }
function conflict(): never { throw new MayuraError('CONFLICT', 'Frontend tool journal command conflicts with its durable state.'); }
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) throw new MayuraError('INVALID_INPUT', 'Invalid frontend journal identifier.'); }
function text(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new MayuraError('INVALID_INPUT', 'Invalid frontend journal text.'); }
function digest(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new MayuraError('INVALID_INPUT', 'Invalid frontend journal digest.'); }
function time(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new MayuraError('INVALID_INPUT', 'Invalid frontend journal time.'); }
const scopeKey = (scope: Scope, agentId: string) => { text(scope.principalId); text(scope.projectId); id(agentId); return hash(['mayura.frontend.scope.v1', scope.principalId, scope.projectId, agentId]); };
function sameScope(a: Scope, b: Scope): boolean { return a.principalId === b.principalId && a.projectId === b.projectId; }
/**
 * Compose a trusted shared journal over an initialized AggregateStore. The host owns authorization, connection
 * lifecycle and retention scheduling. Writes use create-if-absent/CAS; ambiguous driver failures are never replayed.
 * Payload redaction preserves permanent tombstones, so old native calls cannot acquire new execution identities.
 */
export function createAggregateFrontendToolStore(store: AggregateStore, options: AggregateFrontendToolStoreOptions): FrontendToolStore {
  if (!options.permissions?.allow?.includes('frontend-tools:store')) throw new MayuraError('PERMISSION_DENIED', 'Frontend journal storage is not granted.');
  const limits = { maxCallsPerRun: 64, maxRecordBytes: 262_144, maxAttempts: 8, ...options.limits };
  if (!store || typeof store.update !== 'function' || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)
    || limits.maxCallsPerRun > 128 || limits.maxRecordBytes > 786_432 || limits.maxAttempts > 32) throw new MayuraError('INVALID_CONFIG', 'Invalid frontend journal limits.');
  const copy = <T>(value: T): T => freezeJson(jsonValue(value, { maxBytes: limits.maxRecordBytes, maxNodes: 100_000 })) as T;
  const encode = (value: unknown): JsonObject => jsonValue(value, { maxBytes: limits.maxRecordBytes }) as JsonObject;
  const retry = async <T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) { signal?.throwIfAborted(); try { return await operation(); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT' || attempt + 1 >= limits.maxAttempts) throw error; } }
  };
  const runKey = (runId: string) => { id(runId); return `frontend.run:${hash(runId)}`; };
  const callKey = (token: string) => { if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new MayuraError('INVALID_INPUT', 'Invalid frontend journal token.'); return `frontend.call:${hash(token)}`; };
  const readRun = async (scope: Scope, agentId: string, runId: string): Promise<{ row: StoredRecord; state: RunState } | null> => {
    const key = scopeKey(scope, agentId); const row = await store.read(key, runKey(runId)); if (!row) return null;
    let state: RunState;
    try {
      state = copy(row.state) as unknown as RunState;
      if (row.scope !== key || row.id !== runKey(runId) || row.definitionHash !== format || state.format !== 1 || state.kind !== 'frontend.run'
        || state.binding.agentId !== agentId || state.binding.runId !== runId || !sameScope(scope, state.binding.scope)
        || !Array.isArray(state.binding.tools) || state.binding.tools.length > 128 || !Array.isArray(state.slots) || state.slots.length > limits.maxCallsPerRun) bad();
      id(state.binding.threadId); time(state.binding.expiresAtMs);
      const calls = new Set<string>(); const tokens = new Set<string>();
      for (const item of state.binding.tools) { id(item.id); text(item.version); digest(item.digest); }
      if (new Set(state.binding.tools.map(item => item.id)).size !== state.binding.tools.length) bad();
      for (const slot of state.slots) {
        const definition = state.binding.tools.find(item => item.id === slot.toolId);
        if (!definition || definition.version !== slot.toolVersion || definition.digest !== slot.definitionDigest) bad();
        text(slot.callId); id(slot.toolId); text(slot.toolVersion); callKey(slot.token); digest(slot.inputDigest); digest(slot.definitionDigest); time(slot.expiresAtMs); time(slot.retainUntilMs);
        if (calls.has(slot.callId) || tokens.has(slot.token) || slot.expiresAtMs > state.binding.expiresAtMs || slot.retainUntilMs < slot.expiresAtMs) bad(); calls.add(slot.callId); tokens.add(slot.token);
      }
    } catch { return bad(); }
    return { row, state };
  };
  const readCall = async (key: FrontendToolStoreKey): Promise<{ row: StoredRecord; state: FrontendToolCallRecord } | null> => {
    key.signal?.throwIfAborted(); const owner = scopeKey(key.scope, key.agentId); const row = await store.read(owner, callKey(key.token)); if (!row) return null;
    const raw = row.state; let state: FrontendToolCallRecord;
    try {
      state = copy(raw['call']) as unknown as FrontendToolCallRecord;
      if (row.scope !== owner || row.id !== callKey(key.token) || row.definitionHash !== format || raw['format'] !== 1 || raw['kind'] !== 'frontend.call'
        || state.token !== key.token || state.agentId !== key.agentId || !sameScope(state.scope, key.scope) || !['pending', 'claimed', 'settled'].includes(state.status)
        || typeof state.purged !== 'boolean' || (state.waitState !== undefined && !['prepared', 'parked'].includes(state.waitState))
        || (state.waitState === 'prepared' && (state.status !== 'pending' || state.dispatchedRunId !== null))) bad();
      id(state.runId); id(state.threadId); text(state.callId); id(state.toolId); text(state.toolVersion); digest(state.definitionDigest); digest(state.inputDigest); time(state.expiresAtMs); time(state.retainUntilMs);
      if (state.retainUntilMs < state.expiresAtMs || (!state.purged && hash(state.input) !== state.inputDigest)) bad();
      if (state.dispatchedRunId !== null) id(state.dispatchedRunId);
      if ((state.status === 'pending') !== (state.claimId === null) || (state.claimId !== null && !/^[A-Za-z0-9_-]{43}$/.test(state.claimId))) bad();
      if (state.status !== 'pending' && state.dispatchedRunId === null) bad();
      if ((state.status === 'settled') !== (state.outbox !== null)) bad();
      if (state.outbox) { digest(state.outbox.requestDigest); id(state.outbox.continuationRunId); time(state.outbox.acceptedAtMs);
        if (typeof state.outbox.failed !== 'boolean' || ((state.outbox.consumerId === null) !== (state.outbox.reservedAtMs === null))) bad();
        if (state.outbox.consumerId !== null) { id(state.outbox.consumerId); time(state.outbox.reservedAtMs); }
      }
      const run = await readRun(key.scope, key.agentId, state.runId); const slot = run?.state.slots.find(item => item.token === key.token);
      if (!run || !slot || run.state.binding.threadId !== state.threadId || slot.callId !== state.callId || slot.toolId !== state.toolId || slot.toolVersion !== state.toolVersion
        || slot.definitionDigest !== state.definitionDigest || slot.inputDigest !== state.inputDigest || slot.expiresAtMs !== state.expiresAtMs || slot.retainUntilMs !== state.retainUntilMs) bad();
    } catch { return bad(); }
    return { row, state };
  };
  const writeCall = async (row: StoredRecord, state: FrontendToolCallRecord, event: string): Promise<FrontendToolCallRecord> => {
    const result = await store.update({ scope: row.scope, id: row.id, expectedVersion: row.version,
      state: encode({ format: 1, kind: 'frontend.call', call: state }), events: [{ type: event, data: {} }] });
    return copy(result.state['call']) as unknown as FrontendToolCallRecord;
  };
  const mutate = (key: FrontendToolStoreKey, operation: (state: FrontendToolCallRecord) => FrontendToolCallRecord, event: string) => retry(key.signal, async () => {
    const current = await readCall(key); if (!current) conflict(); const next = operation(current.state);
    return next === current.state ? current.state : writeCall(current.row, next, event);
  });
  const api: FrontendToolStore = {
    async bind(raw, signal) {
      const binding = copy(raw); scopeKey(binding.scope, binding.agentId); id(binding.runId); id(binding.threadId); time(binding.expiresAtMs);
      if (binding.expiresAtMs <= Date.now() || !Array.isArray(binding.tools) || binding.tools.length > 128 || new Set(binding.tools.map(tool => tool.id)).size !== binding.tools.length) conflict();
      for (const item of binding.tools) { id(item.id); text(item.version); digest(item.digest); }
      const expected = hash({ ...binding, expiresAtMs: 0 }); signal?.throwIfAborted();
      const state: RunState = { format: 1, kind: 'frontend.run', binding, slots: [] };
      try { await store.create({ scope: scopeKey(binding.scope, binding.agentId), id: runKey(binding.runId), idempotencyKey: runKey(binding.runId), definitionHash: format,
        state: encode(state), events: [{ type: 'frontend.bound', data: {} }] }); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      const saved = await readRun(binding.scope, binding.agentId, binding.runId);
      if (!saved || hash({ ...saved.state.binding, expiresAtMs: 0 }) !== expected) conflict();
    },
    async binding(scope, agentId, runId, signal) { signal?.throwIfAborted(); return (await readRun(scope, agentId, runId))?.state.binding ?? null; },
    async register(raw) {
      const { signal, ...data } = raw; signal?.throwIfAborted(); const input = copy(data); const value = copy(input.input); const inputDigest = hash(value); const freshToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      text(input.callId); id(input.toolId); text(input.toolVersion); digest(input.definitionDigest); time(input.timeoutMs); time(input.retentionMs);
      if (input.timeoutMs < 1 || input.timeoutMs > 3_600_000 || input.retentionMs < 1 || input.retentionMs > 86_400_000) conflict();
      const slot = await retry(signal, async () => {
        const run = await readRun(input.scope, input.agentId, input.runId); if (!run) conflict();
        const existing = run.state.slots.find(item => item.callId === input.callId);
        if (existing) {
          if (existing.toolId !== input.toolId || existing.toolVersion !== input.toolVersion || existing.definitionDigest !== input.definitionDigest || existing.inputDigest !== inputDigest) conflict(); return existing;
        }
        const definition = run.state.binding.tools.find(item => item.id === input.toolId);
        if (!definition || definition.version !== input.toolVersion || definition.digest !== input.definitionDigest || Date.now() >= run.state.binding.expiresAtMs) conflict();
        if (run.state.slots.length >= limits.maxCallsPerRun) throw new MayuraError('LIMIT_EXCEEDED', 'Frontend run call limit reached.');
        const expiresAtMs = Math.min(run.state.binding.expiresAtMs, Date.now() + input.timeoutMs);
        const created: Slot = { token: freshToken, callId: input.callId, toolId: input.toolId, toolVersion: input.toolVersion, definitionDigest: input.definitionDigest, inputDigest,
          expiresAtMs, retainUntilMs: expiresAtMs + input.retentionMs };
        await store.update({ scope: run.row.scope, id: run.row.id, expectedVersion: run.row.version, state: encode({ ...run.state, slots: [...run.state.slots, created] }), events: [{ type: 'frontend.registered', data: {} }] }); return created;
      });
      const call: FrontendToolCallRecord = { scope: input.scope, agentId: input.agentId, runId: input.runId, threadId: (await api.binding(input.scope, input.agentId, input.runId, signal))!.threadId,
        token: slot.token, callId: slot.callId, toolId: slot.toolId, toolVersion: slot.toolVersion, definitionDigest: slot.definitionDigest,
        ...(input.recoverable ? { waitState: 'prepared' as const } : {}), input: value, inputDigest, expiresAtMs: slot.expiresAtMs, retainUntilMs: slot.retainUntilMs, status: 'pending', dispatchedRunId: null, claimId: null, outbox: null, purged: false };
      try { await store.create({ scope: scopeKey(input.scope, input.agentId), id: callKey(slot.token), idempotencyKey: callKey(slot.token), definitionHash: format,
        state: encode({ format: 1, kind: 'frontend.call', call }), events: [{ type: 'frontend.created', data: {} }] }); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      const saved = (await readCall({ scope: input.scope, agentId: input.agentId, token: slot.token, ...(signal ? { signal } : {}) }))?.state ?? bad();
      if ((saved.waitState !== undefined) !== (input.recoverable === true)) conflict();
      return saved;
    },
    async calls(scope, agentId, runId, signal) {
      const run = await readRun(scope, agentId, runId); if (!run) return [];
      const result: FrontendToolCallRecord[] = [];
      for (const slot of run.state.slots) { signal?.throwIfAborted(); const call = await api.read({ scope, agentId, token: slot.token, ...(signal ? { signal } : {}) }); if (call) result.push(call); }
      return Object.freeze(result);
    },
    async read(key) { return (await readCall(key))?.state ?? null; },
    park(key) { return mutate(key, state => {
      if (state.purged || !state.waitState || Date.now() >= state.expiresAtMs) conflict();
      return state.waitState === 'prepared' ? { ...state, waitState: 'parked' } : state;
    }, 'frontend.parked'); },
    dispatch(key, externalRunId) { id(externalRunId); return mutate(key, state => {
      if (state.purged || state.waitState === 'prepared' || state.status !== 'pending' || Date.now() >= state.expiresAtMs) conflict();
      return state.dispatchedRunId === null ? { ...state, dispatchedRunId: externalRunId } : state;
    }, 'frontend.dispatched'); },
    claim(key, claimId) { if (!/^[A-Za-z0-9_-]{43}$/.test(claimId)) conflict(); return mutate(key, state => {
      if (state.purged || state.waitState === 'prepared' || state.status !== 'pending' || !state.dispatchedRunId || Date.now() >= state.expiresAtMs) conflict();
      return { ...state, status: 'claimed', claimId };
    }, 'frontend.claimed'); },
    accept(key, raw) { const input = copy(raw); id(input.threadId); id(input.continuationRunId); digest(input.requestDigest);
      if (typeof input.failed !== 'boolean') conflict();
      return mutate(key, state => {
        if (state.purged || Date.now() >= state.retainUntilMs || state.claimId !== input.claimId || state.threadId !== input.threadId || state.dispatchedRunId === input.continuationRunId) conflict();
        if (state.outbox) { if (state.outbox.requestDigest !== input.requestDigest || state.outbox.continuationRunId !== input.continuationRunId || state.outbox.failed !== input.failed || hash(state.outbox.value) !== hash(input.value)) conflict(); return state; }
        if (state.status !== 'claimed') conflict();
        return { ...state, status: 'settled', outbox: { requestDigest: input.requestDigest, continuationRunId: input.continuationRunId, value: input.value, failed: input.failed,
          acceptedAtMs: Date.now(), consumerId: null, reservedAtMs: null } };
      }, 'frontend.result.accepted');
    },
    reserveResult(key, consumerId) { id(consumerId); return mutate(key, state => {
      if (state.purged || !state.outbox || Date.now() >= state.retainUntilMs) conflict();
      if (state.outbox.consumerId !== null) { if (state.outbox.consumerId !== consumerId) conflict(); return state; }
      return { ...state, outbox: { ...state.outbox, consumerId, reservedAtMs: Date.now() } };
    }, 'frontend.result.reserved'); },
    async purgeExpired(scope, agentId, runId, signal) {
      let purged = 0;
      for (const call of await api.calls(scope, agentId, runId, signal)) if (!call.purged && Date.now() >= call.retainUntilMs) {
        await mutate({ scope, agentId, token: call.token, ...(signal ? { signal } : {}) }, current => {
          if (current.purged || Date.now() < current.retainUntilMs) return current;
          return { ...current, purged: true, input: null, outbox: current.outbox ? { ...current.outbox, value: null } : null };
        }, 'frontend.content.purged'); purged++;
      }
      return purged;
    },
  };
  return Object.freeze(api);
}
