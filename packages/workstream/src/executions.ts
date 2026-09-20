import { freezeJson, jsonValue, MayuraError, type ErrorCode, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import {
  StorageError, executionWaitCommand, executionWaitHashMaterial, executionWaitSnapshot, workflowHashMaterial,
  type ExecutionRef, type ExecutionWaitAggregateStore, type ExecutionWaitSnapshot, type ExecutionWaitStore, type ExecutionWaitStreamKey, type StoredEvent,
} from '@mayura/storage-contracts';

export type { ExecutionRef, ExecutionCompletion, ExecutionWaitSnapshot } from '@mayura/storage-contracts';

export interface ExecutionWorkStreamOptions {
  readonly store: ExecutionWaitAggregateStore;
  readonly scope: Scope;
  readonly policyHash: string;
  readonly streamId: string;
  /** Logical acknowledgment deadline, not a transaction rollback or permission to retry effects. */
  readonly storageTimeoutMs?: number;
  /** Includes timed-out callbacks until their actual promises settle. */
  readonly maxPendingStorageOperations?: number;
}
export interface ExecutionWorkStream {
  initialize(): Promise<void>;
  register(command: { readonly id: string; readonly targets: readonly ExecutionRef[] }): Promise<ExecutionWaitSnapshot>;
  inspect(id: string): Promise<ExecutionWaitSnapshot | undefined>;
  cancel(id: string): Promise<ExecutionWaitSnapshot>;
  drainReady(options?: { readonly limit?: number }): Promise<readonly ExecutionWaitSnapshot[]>;
  events(after?: number): Promise<readonly StoredEvent[]>;
  /** Stops this facade only; caller-owned storage and persisted targets/waits remain unchanged. */
  close(): Promise<void>;
}

const methods = ['initialize', 'open', 'materialize', 'register', 'inspect', 'cancel', 'drainReady', 'events'] as const;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const hex = /^[a-f0-9]{64}$/;
const unavailable = (): MayuraError => new MayuraError('STORAGE_UNAVAILABLE', 'Execution-wait persistence could not be confirmed. Inspect state or retry the same immutable registration.');
const invalid = (): MayuraError => new MayuraError('INVALID_INPUT', 'Execution waits require bounded exact identifiers, references and command fields.');
const cancelled = (): MayuraError => new MayuraError('CANCELLED', 'The execution WorkStream facade is closed.');

function object(value: JsonValue): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value;
}
function exact(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid();
}
function positive(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1 || result > maximum) throw invalid();
  return result;
}

/** Resolve only data descriptors, preserving ordinary class receivers without running getters. */
function member(value: object, name: string): unknown {
  let current: object | null = value;
  for (let depth = 0; current && depth < 16; depth++, current = Object.getPrototypeOf(current) as object | null) {
    const field = Object.getOwnPropertyDescriptor(current, name);
    if (field) { if (!('value' in field)) throw invalid(); return field.value; }
  }
  throw invalid();
}
function adapter(store: unknown): ExecutionWaitStore {
  if (!store || typeof store !== 'object') throw invalid();
  const capability = member(store, 'executionWaits');
  if (!capability || typeof capability !== 'object') throw invalid();
  const captured: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of methods) {
    const method = member(capability, name);
    if (typeof method !== 'function') throw invalid();
    captured[name] = (...args: unknown[]) => Reflect.apply(method, capability, args);
  }
  return Object.freeze(captured) as unknown as ExecutionWaitStore;
}
function storageFailure(error: unknown): MayuraError {
  let code: ErrorCode = 'STORAGE_UNAVAILABLE';
  try {
    const field = error instanceof StorageError ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const raw: unknown = field && 'value' in field ? field.value : undefined;
    if (raw === 'QUEUE_FULL') code = 'LIMIT_EXCEEDED';
    else if (raw === 'INVALID_INPUT' || raw === 'NOT_FOUND' || raw === 'CONFLICT' || raw === 'LIMIT_EXCEEDED') code = raw;
  } catch { /* Exception proxies and messages never become public diagnostics. */ }
  return new MayuraError(code, 'Execution-wait persistence could not confirm this command. Inspect current state before retrying.');
}
async function sha256(material: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * A finite metadata-only completion join facade. References are data, not capabilities;
 * the configured adapter must enforce authoritative scoped scheduled-run identity.
 */
export function createExecutionWorkStream(options: ExecutionWorkStreamOptions): ExecutionWorkStream {
  let api: ExecutionWaitStore; let scope: Scope; let streamId: string; let policyHash: string;
  let storageTimeoutMs: number; let maxPending: number;
  try {
    if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw invalid();
    const fields = Object.getOwnPropertyDescriptors(options);
    const allowed = ['store', 'scope', 'policyHash', 'streamId', 'storageTimeoutMs', 'maxPendingStorageOperations'];
    if (Reflect.ownKeys(fields).some(name => typeof name !== 'string' || !allowed.includes(name))
      || Object.values(fields).some(field => !field.enumerable || !('value' in field))) throw invalid();
    api = adapter(fields['store']?.value);
    const rawScope = object(jsonValue(fields['scope']?.value, { maxBytes: 2048 })); exact(rawScope, ['principalId', 'projectId']);
    // Scope labels follow scheduled workflowPolicy, not the narrower stream/wait ID syntax.
    // This preserves exact identity for valid email, namespaced and Unicode principals.
    if (typeof rawScope['principalId'] !== 'string' || rawScope['principalId'].length < 1 || rawScope['principalId'].length > 128
      || typeof rawScope['projectId'] !== 'string' || rawScope['projectId'].length < 1 || rawScope['projectId'].length > 128) throw invalid();
    scope = Object.freeze({ principalId: rawScope['principalId'], projectId: rawScope['projectId'] });
    const rawStream: unknown = fields['streamId']?.value; const rawPolicy: unknown = fields['policyHash']?.value;
    if (typeof rawStream !== 'string' || !identifier.test(rawStream) || typeof rawPolicy !== 'string' || !hex.test(rawPolicy)) throw invalid();
    streamId = rawStream; policyHash = rawPolicy;
    storageTimeoutMs = positive(fields['storageTimeoutMs']?.value, 10_000, 30_000);
    maxPending = positive(fields['maxPendingStorageOperations']?.value, 64, 1_024);
  } catch { throw new MayuraError('INVALID_CONFIG', 'Execution WorkStream requires an explicit adapter capability, scope, policy, stream ID and finite limits.'); }

  let closed = false; let pending = 0; let key: ExecutionWaitStreamKey | undefined; let initializing: Promise<void> | undefined;
  const stops = new Set<() => void>();
  // At most 128 lifetime identities exist in one stream; do not retain unbounded custom-store IDs.
  const identities = new Map<string, string>();
  const open = (): void => { if (closed) throw cancelled(); };
  const ready = (): ExecutionWaitStreamKey => {
    open(); if (!key) throw new MayuraError('INVALID_CONFIG', 'Initialize the execution WorkStream before accessing it.'); return key;
  };
  const input = <T>(operation: () => T): T => { try { return operation(); } catch { throw invalid(); } };

  /** Logical completion never releases an actual pending adapter callback's capacity. */
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    open();
    if (pending >= maxPending) throw new MayuraError('LIMIT_EXCEEDED', 'The bounded execution-wait persistence capacity is occupied.');
    pending++;
    const actual = Promise.resolve().then(() => { open(); return operation(); }).finally(() => { pending--; });
    return await new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (action: () => void): void => {
        if (finished) return; finished = true; clearTimeout(timer); stops.delete(stop); action();
      };
      const stop = (): void => finish(() => reject(cancelled()));
      const timer = setTimeout(() => finish(() => reject(unavailable())), storageTimeoutMs);
      stops.add(stop);
      actual.then(value => finish(() => resolve(value)), (error: unknown) => finish(() => reject(storageFailure(error))));
      if (closed) stop();
    });
  };

  const checked = async (raw: unknown, expectedId?: string, expectedTargets?: readonly ExecutionRef[]): Promise<ExecutionWaitSnapshot> => {
    try {
      const value = executionWaitSnapshot(raw);
      if ((expectedId !== undefined && value.id !== expectedId) || value.targets.some(target => target.policyHash !== policyHash)) throw unavailable();
      const identity = await sha256(executionWaitHashMaterial(ready(), value.id, value.targets));
      open();
      if (value.definitionHash !== identity || (identities.has(value.id) && identities.get(value.id) !== identity)) throw unavailable();
      if (expectedTargets && workflowHashMaterial('mayura:execution-targets:v1', value.targets) !== workflowHashMaterial('mayura:execution-targets:v1', expectedTargets)) throw unavailable();
      return value;
    } catch { open(); throw unavailable(); }
  };
  const remember = (values: readonly ExecutionWaitSnapshot[]): void => {
    const fresh = new Set(values.filter(value => !identities.has(value.id)).map(value => value.id));
    if (identities.size + fresh.size > 128) throw unavailable();
    for (const value of values) {
      if (identities.has(value.id) && identities.get(value.id) !== value.definitionHash) throw unavailable();
    }
    for (const value of values) identities.set(value.id, value.definitionHash);
  };
  const access = (id: string): ExecutionWaitStreamKey & { readonly id: string } => {
    const configured = ready(); return input(() => executionWaitCommand('inspect', { ...configured, id })) as unknown as ExecutionWaitStreamKey & { readonly id: string };
  };

  return Object.freeze<ExecutionWorkStream>({
    initialize: async (): Promise<void> => {
      open();
      initializing ??= (async () => {
        let scopeHash: string;
        try { scopeHash = await sha256(workflowHashMaterial('mayura:scope:v1', scope)); } catch { open(); throw unavailable(); }
        open();
        if (await call(() => api.initialize()) !== undefined) throw unavailable();
        const configured = Object.freeze({ scope: scopeHash, streamId, policyHash });
        if (await call(() => api.open(configured)) !== undefined) throw unavailable();
        open(); key = configured;
      })().catch((error: unknown) => { initializing = undefined; throw error; });
      await initializing; open();
    },
    register: async (registration): Promise<ExecutionWaitSnapshot> => {
      const configured = ready();
      const command = input(() => {
        const raw = object(jsonValue(registration, { maxBytes: 65_536 })); exact(raw, ['id', 'targets']);
        return executionWaitCommand('register', { ...configured, ...raw });
      }) as unknown as Parameters<ExecutionWaitStore['register']>[0];
      if (command.targets.some(target => target.policyHash !== policyHash)) {
        throw new MayuraError('CONFLICT', 'Execution references must match this stream\'s pinned policy.');
      }
      const result = await checked(await call(() => api.register(command)), command.id, command.targets); open(); remember([result]); return result;
    },
    inspect: async (id): Promise<ExecutionWaitSnapshot | undefined> => {
      const command = access(id); const raw = await call(() => api.inspect(command)); open();
      if (raw === undefined) return undefined;
      const result = await checked(raw, id); open(); remember([result]); return result;
    },
    cancel: async (id): Promise<ExecutionWaitSnapshot> => {
      const command = access(id); const result = await checked(await call(() => api.cancel(command)), id); open();
      if (result.status === 'waiting') throw unavailable(); remember([result]); return result;
    },
    drainReady: async (options = {}): Promise<readonly ExecutionWaitSnapshot[]> => {
      const configured = ready(); const command = input(() => {
        const raw = object(jsonValue(options, { maxBytes: 1024 })); exact(raw, [], ['limit']);
        return executionWaitCommand('drainReady', { ...configured, limit: Object.hasOwn(raw, 'limit') ? raw['limit'] : 16 });
      }) as unknown as Parameters<ExecutionWaitStore['drainReady']>[0];
      const raw = await call(() => api.drainReady(command)); open();
      let page: JsonValue;
      try { page = jsonValue(raw, { maxBytes: 3_145_728, maxNodes: 100_000 }); } catch { throw unavailable(); }
      if (!Array.isArray(page) || page.length > command.limit) throw unavailable();
      const values: ExecutionWaitSnapshot[] = [];
      for (const entry of page) values.push(await checked(entry));
      open();
      if (new Set(values.map(value => value.id)).size !== values.length || values.some(value => value.status !== 'resolved')) throw unavailable();
      remember(values); return Object.freeze(values);
    },
    events: async (after = 0): Promise<readonly StoredEvent[]> => {
      const configured = ready();
      const command = input(() => executionWaitCommand('events', { ...configured, after })) as unknown as Parameters<ExecutionWaitStore['events']>[0];
      const raw = await call(() => api.events(command)); open();
      try {
        const values = jsonValue(raw, { maxBytes: 1_048_576 });
        if (!Array.isArray(values) || values.length > 1000) throw unavailable();
        let previous = after; let previousTime = Number.NEGATIVE_INFINITY;
        const lifecycle = new Map<string, 'registered' | 'terminal'>();
        for (const value of values) {
          const event = object(value); exact(event, ['sequence', 'createdAt', 'type', 'data']);
          const sequence = event['sequence']; const time = event['createdAt']; const type = event['type'];
          if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence !== previous + 1 || sequence > 257
            || typeof time !== 'string' || time.length > 32 || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) throw unavailable();
          const timestamp = Date.parse(time);
          if (timestamp < previousTime) throw unavailable();
          const data = object(event['data']!);
          if (type === 'stream.created') { exact(data, []); if (sequence !== 1) throw unavailable(); }
          else {
            if (sequence === 1 || !['wait.registered', 'wait.resolved', 'wait.cancelled'].includes(type as string)) throw unavailable();
            exact(data, ['waitId']); if (typeof data['waitId'] !== 'string' || !identifier.test(data['waitId'])) throw unavailable();
            const waitId = data['waitId']; const prior = lifecycle.get(waitId);
            if (type === 'wait.registered') {
              if (prior !== undefined) throw unavailable();
              lifecycle.set(waitId, 'registered');
            } else {
              // A complete prefix proves registration; a cursor page may start after it.
              if (prior === 'terminal' || (after === 0 && prior !== 'registered')) throw unavailable();
              lifecycle.set(waitId, 'terminal');
            }
            if (lifecycle.size > 128) throw unavailable();
          }
          previous = sequence; previousTime = timestamp;
        }
        open(); return freezeJson(values) as unknown as readonly StoredEvent[];
      } catch { open(); throw unavailable(); }
    },
    close: async (): Promise<void> => { if (!closed) { closed = true; for (const stop of stops) stop(); } },
  });
}
