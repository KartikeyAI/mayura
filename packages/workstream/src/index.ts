import { freezeJson, jsonValue, MayuraError, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredEvent, type StoredEventInput, type StoredRecord } from '@mayura/storage';

export interface SignalRecord { readonly id: string; readonly name: string; readonly value: JsonValue; readonly sequence: number }
export interface WaitCondition { readonly id: string; readonly name: string; readonly after?: number }
export interface WaitDefinition { readonly id: string; readonly mode: 'all' | 'any'; readonly conditions: readonly WaitCondition[] }
export interface WaitMatch { readonly conditionId: string; readonly signal: SignalRecord }
export interface WaitSnapshot extends WaitDefinition {
  readonly status: 'waiting' | 'succeeded' | 'cancelled';
  readonly matches: readonly WaitMatch[];
}
export interface WorkStreamOptions { readonly store: AggregateStore; readonly scope: Scope; readonly streamId: string }
export interface WorkStream {
  initialize(): Promise<void>;
  signal(input: { readonly id: string; readonly name: string; readonly value: JsonValue }): Promise<SignalRecord>;
  register(definition: WaitDefinition): Promise<WaitSnapshot>;
  inspect(id: string): Promise<WaitSnapshot | undefined>;
  cancel(id: string): Promise<WaitSnapshot>;
  signals(options?: { readonly after?: number; readonly limit?: number }): Promise<{ readonly items: readonly SignalRecord[]; readonly next: number }>;
  events(after?: number): Promise<readonly StoredEvent[]>;
}
interface State { format: 1; streamId: string; signals: SignalRecord[]; waits: WaitSnapshot[] }
const SIGNALS = 256;
const WAITS = 128;
const CONDITIONS = 32;
const VALUE_BYTES = 4096;
const STATE_BYTES = 1_048_576;
const FORMAT_HASH = 'mayura-workstream-v1';

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)) throw new MayuraError('INVALID_INPUT', 'WorkStream identifiers must be bounded simple identifiers.');
}
function cursor(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) throw new MayuraError('INVALID_INPUT', 'A signal cursor must be a nonnegative safe integer.');
}
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('INVALID_INPUT', 'WorkStream data must be a plain JSON object.');
  return value;
}
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
function equal(left: unknown, right: unknown): boolean { return canonical(jsonValue(left)) === canonical(jsonValue(right)); }
function immutable<T>(value: T): T { return freezeJson(jsonValue(value, { maxBytes: STATE_BYTES })) as T; }
function definition(value: unknown): WaitDefinition {
  const raw = object(jsonValue(value));
  identifier(raw['id']);
  if ((raw['mode'] !== 'all' && raw['mode'] !== 'any') || !Array.isArray(raw['conditions']) || raw['conditions'].length < 1 || raw['conditions'].length > CONDITIONS || Object.keys(raw).some(key => !['id', 'mode', 'conditions'].includes(key))) {
    throw new MayuraError('INVALID_INPUT', 'A wait needs a mode and 1–32 named conditions.');
  }
  const conditions = raw['conditions'].map(item => {
    const part = object(item); identifier(part['id']); identifier(part['name']);
    if (Object.keys(part).some(key => !['id', 'name', 'after'].includes(key))) throw new MayuraError('INVALID_INPUT', 'Unknown wait-condition field.');
    const after = part['after'] === undefined ? 0 : part['after']; cursor(after);
    return { id: part['id'], name: part['name'], after };
  });
  if (new Set(conditions.map(condition => condition.id)).size !== conditions.length) throw new MayuraError('INVALID_INPUT', 'Wait condition IDs must be unique.');
  return immutable({ id: raw['id'], mode: raw['mode'], conditions });
}
function matched(wait: WaitDefinition, signals: readonly SignalRecord[]): readonly WaitMatch[] | undefined {
  const matches: WaitMatch[] = [];
  for (const condition of wait.conditions) {
    const signal = signals.find(item => item.name === condition.name && item.sequence > (condition.after ?? 0));
    if (signal) matches.push({ conditionId: condition.id, signal });
  }
  if (wait.mode === 'all') return matches.length === wait.conditions.length ? matches : undefined;
  if (matches.length === 0) return undefined;
  // Stable sort preserves declared condition order when two conditions see the same signal.
  matches.sort((left, right) => left.signal.sequence - right.signal.sequence);
  return [matches[0]!];
}
function settle(state: State): StoredEventInput[] {
  const events: StoredEventInput[] = [];
  state.waits = state.waits.map(wait => {
    if (wait.status !== 'waiting') return wait;
    const matches = matched(wait, state.signals);
    if (!matches) return wait;
    events.push({ type: 'wait.succeeded', data: { waitId: wait.id } });
    return { ...wait, status: 'succeeded', matches };
  });
  return events;
}

/** Validate the persisted wire shape and its derivable match invariants before any disclosure. */
function stateFrom(record: StoredRecord, streamId: string, scopeKey: string): State {
  try {
    const state = object(jsonValue(record.state, { maxBytes: STATE_BYTES }));
    if (record.scope !== scopeKey || record.id !== streamId || record.definitionHash !== FORMAT_HASH || state['format'] !== 1 || state['streamId'] !== streamId || Object.keys(state).some(key => !['format', 'streamId', 'signals', 'waits'].includes(key)) || !Array.isArray(state['signals']) || state['signals'].length > SIGNALS || !Array.isArray(state['waits']) || state['waits'].length > WAITS) throw new Error();
    const signals = state['signals'].map((raw, index): SignalRecord => {
      const item = object(raw); identifier(item['id']); identifier(item['name']);
      if (item['sequence'] !== index + 1 || !Object.hasOwn(item, 'value') || Object.keys(item).some(key => !['id', 'name', 'value', 'sequence'].includes(key))) throw new Error();
      return { id: item['id'], name: item['name'], sequence: index + 1, value: jsonValue(item['value'], { maxBytes: VALUE_BYTES }) };
    });
    if (new Set(signals.map(item => item.id)).size !== signals.length) throw new Error();
    const waits = state['waits'].map((raw): WaitSnapshot => {
      const item = object(raw);
      const def = definition({ id: item['id'], mode: item['mode'], conditions: item['conditions'] });
      if (typeof item['status'] !== 'string' || !['waiting', 'succeeded', 'cancelled'].includes(item['status']) || !Array.isArray(item['matches']) || Object.keys(item).some(key => !['id', 'mode', 'conditions', 'status', 'matches'].includes(key))) throw new Error();
      const result = matched(def, signals);
      if (item['status'] === 'succeeded') {
        if (!result || !equal(result, item['matches'])) throw new Error();
        return { ...def, status: 'succeeded', matches: result };
      }
      if (item['matches'].length !== 0 || (item['status'] === 'waiting' && result)) throw new Error();
      return { ...def, status: item['status'] as 'waiting' | 'cancelled', matches: [] };
    });
    if (new Set(waits.map(item => item.id)).size !== waits.length) throw new Error();
    return { format: 1, streamId, signals, waits };
  } catch { throw new MayuraError('INVALID_INPUT', 'Stored WorkStream data failed format or integrity validation.'); }
}

/** Durable bounded broadcast signals. The caller supplies verified identity and owns storage lifecycle. */
export function createWorkStream(options: WorkStreamOptions): WorkStream {
  identifier(options.streamId); identifier(options.scope?.principalId); identifier(options.scope?.projectId);
  const streamId = options.streamId;
  const scope = { principalId: options.scope.principalId, projectId: options.scope.projectId };
  const store = options.store;
  let scopeKey: string | undefined;
  let initializePromise: Promise<void> | undefined;
  const storage = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof StorageError && error.code === 'CONFLICT') throw new MayuraError('CONFLICT', 'The WorkStream record changed concurrently.');
      throw new MayuraError('STORAGE_UNAVAILABLE', 'WorkStream storage is unavailable; retry the same stable command after recovery.');
    }
  };
  const requireScope = (): string => {
    if (!scopeKey) throw new MayuraError('INVALID_CONFIG', 'Initialize WorkStream before accessing it.');
    return scopeKey;
  };
  const read = async (): Promise<{ record: StoredRecord; state: State }> => {
    const key = requireScope();
    const record = await storage(() => store.read(key, streamId));
    if (!record) throw new MayuraError('NOT_FOUND', 'WorkStream was not found in the configured scope.');
    return { record, state: stateFrom(record, streamId, key) };
  };
  const update = async <T>(transition: (state: State) => { result: T; events: StoredEventInput[] }): Promise<T> => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const { record, state } = await read();
      const { result, events } = transition(state);
      if (events.length === 0) return immutable(result);
      let serialized: JsonObject;
      try { serialized = object(jsonValue(state, { maxBytes: STATE_BYTES })); }
      catch { throw new MayuraError('LIMIT_EXCEEDED', 'The bounded WorkStream state is full.'); }
      try {
        await store.update({ scope: requireScope(), id: streamId, expectedVersion: record.version, state: serialized, events });
        return immutable(result);
      } catch (error) {
        if (error instanceof StorageError && error.code === 'CONFLICT') continue;
        throw new MayuraError('STORAGE_UNAVAILABLE', 'WorkStream update could not be confirmed; retry the same stable command.');
      }
    }
    throw new MayuraError('CONFLICT', 'WorkStream remained busy after bounded conflict retries.');
  };
  return Object.freeze({
    initialize: async (): Promise<void> => {
      if (!initializePromise) initializePromise = (async () => {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mayura:workstream-scope:v1\0${canonical(scope)}`));
        const key = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const created = await storage(() => store.create({ scope: key, id: streamId, idempotencyKey: streamId, definitionHash: FORMAT_HASH,
          state: { format: 1, streamId, signals: [], waits: [] }, events: [{ type: 'stream.created', data: {} }],
        }));
        stateFrom(created.record, streamId, key); scopeKey = key;
      })().catch((error: unknown) => { initializePromise = undefined; throw error; });
      await initializePromise;
    },
    signal: async (input: { readonly id: string; readonly name: string; readonly value: JsonValue }): Promise<SignalRecord> => {
      const raw = object(jsonValue(input, { maxBytes: VALUE_BYTES + 1024 }));
      identifier(raw['id']); identifier(raw['name']);
      if (!Object.hasOwn(raw, 'value') || Object.keys(raw).some(key => !['id', 'name', 'value'].includes(key))) throw new MayuraError('INVALID_INPUT', 'Signal requires only id, name and bounded JSON value.');
      const signal = { id: raw['id'], name: raw['name'], value: jsonValue(raw['value'], { maxBytes: VALUE_BYTES }) };
      return update(state => {
        const existing = state.signals.find(item => item.id === signal.id);
        if (existing) {
          if (!equal({ id: existing.id, name: existing.name, value: existing.value }, signal)) throw new MayuraError('CONFLICT', 'Signal ID already identifies different content.');
          return { result: existing, events: [] };
        }
        if (state.signals.length >= SIGNALS) throw new MayuraError('LIMIT_EXCEEDED', 'The stream signal-retention limit was reached.');
        const entry: SignalRecord = { ...signal, sequence: state.signals.length + 1 };
        state.signals.push(entry);
        return { result: entry, events: [{ type: 'signal.received', data: { signalId: entry.id, sequence: entry.sequence } }, ...settle(state)] };
      });
    },
    register: async (input: WaitDefinition): Promise<WaitSnapshot> => {
      const def = definition(input);
      return update(state => {
        const existing = state.waits.find(wait => wait.id === def.id);
        if (existing) {
          if (!equal({ id: existing.id, mode: existing.mode, conditions: existing.conditions }, def)) throw new MayuraError('CONFLICT', 'Wait ID already identifies a different definition.');
          return { result: existing, events: [] };
        }
        if (state.waits.length >= WAITS) throw new MayuraError('LIMIT_EXCEEDED', 'The stream wait-retention limit was reached.');
        state.waits.push({ ...def, status: 'waiting', matches: [] });
        const completed = settle(state);
        return { result: state.waits.find(wait => wait.id === def.id)!, events: [{ type: 'wait.registered', data: { waitId: def.id } }, ...completed] };
      });
    },
    inspect: async (id: string): Promise<WaitSnapshot | undefined> => {
      identifier(id); const { state } = await read(); const wait = state.waits.find(item => item.id === id);
      return wait ? immutable(wait) : undefined;
    },
    cancel: async (id: string): Promise<WaitSnapshot> => {
      identifier(id);
      return update(state => {
        const index = state.waits.findIndex(wait => wait.id === id); const current = state.waits[index];
        if (!current) throw new MayuraError('NOT_FOUND', 'Wait was not found in this stream.');
        if (current.status !== 'waiting') return { result: current, events: [] };
        const cancelled: WaitSnapshot = { ...current, status: 'cancelled', matches: [] };
        state.waits[index] = cancelled;
        return { result: cancelled, events: [{ type: 'wait.cancelled', data: { waitId: id } }] };
      });
    },
    signals: async (options: { readonly after?: number; readonly limit?: number } = {}) => {
      const after = options.after === undefined ? 0 : options.after;
      const limit = options.limit === undefined ? 100 : options.limit; cursor(after);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MayuraError('INVALID_INPUT', 'Signal page size must be between 1 and 100.');
      const { state } = await read();
      const items = state.signals.filter(signal => signal.sequence > after).slice(0, limit);
      return immutable({ items, next: items.at(-1)?.sequence ?? after });
    },
    events: async (after = 0): Promise<readonly StoredEvent[]> => {
      cursor(after); const key = requireScope();
      return immutable(await storage(() => store.events(key, streamId, after)));
    },
  });
}
