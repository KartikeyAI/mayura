import { freezeJson, jsonValue, MayuraError, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredEvent, type StoredEventInput, type StoredRecord } from '@mayura/storage-contracts';

export interface TimerDefinition {
  readonly id: string;
  /** Absolute Unix epoch millisecond due time. */
  readonly dueAtMs: number;
  /** Safe bounded application correlation data; not execution authority. */
  readonly payload?: JsonValue;
}

export interface TimerSnapshot extends TimerDefinition {
  readonly status: 'scheduled' | 'fired' | 'cancelled';
  readonly firedAtMs?: number;
}

export interface TimerWorkStreamOptions {
  readonly store: AggregateStore;
  readonly scope: Scope;
  readonly streamId: string;
  /** Trusted synchronized host clock. */
  readonly now?: () => number;
}

export interface TimerWorkStream {
  initialize(): Promise<void>;
  schedule(definition: TimerDefinition): Promise<TimerSnapshot>;
  inspect(id: string): Promise<TimerSnapshot | undefined>;
  cancel(id: string): Promise<TimerSnapshot>;
  /** Atomically fires at most `limit` due timers in due-time/ID order. */
  sweepDue(options?: { readonly limit?: number }): Promise<readonly TimerSnapshot[]>;
  list(options?: { readonly afterId?: string; readonly limit?: number }): Promise<{ readonly items: readonly TimerSnapshot[]; readonly next: string | null }>;
  events(after?: number): Promise<readonly StoredEvent[]>;
}

interface State { format: 1; streamId: string; timers: TimerSnapshot[] }
const TIMERS = 256;
const PAYLOAD_BYTES = 2_048;
const STATE_BYTES = 1_048_576;
const FORMAT_HASH = 'mayura-timer-workstream-v1';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new MayuraError('INVALID_INPUT', 'Timer identifiers must be bounded simple identifiers.');
}
function timestamp(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_INPUT', 'Timer due time must be a nonnegative safe Unix epoch millisecond value.');
}
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('INVALID_INPUT', 'Timer data must be a plain JSON object.');
  return value;
}
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
function immutable<T>(value: T): T { return freezeJson(jsonValue(value, { maxBytes: STATE_BYTES })) as unknown as T; }
function equal(left: JsonValue, right: JsonValue): boolean { return canonical(left) === canonical(right); }
function compareId(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function definition(value: unknown): TimerDefinition {
  const raw = object(jsonValue(value, { maxBytes: PAYLOAD_BYTES + 1_024 }));
  if (Object.keys(raw).some(key => !['id', 'dueAtMs', 'payload'].includes(key))) throw new MayuraError('INVALID_INPUT', 'Timer definition contains an unknown field.');
  identifier(raw['id']); timestamp(raw['dueAtMs']);
  return immutable({ id: raw['id'], dueAtMs: raw['dueAtMs'], ...(raw['payload'] === undefined ? {} : { payload: jsonValue(raw['payload'], { maxBytes: PAYLOAD_BYTES }) }) });
}

function stateFrom(record: StoredRecord, streamId: string, scopeKey: string): State {
  try {
    const raw = object(jsonValue(record.state, { maxBytes: STATE_BYTES }));
    if (record.scope !== scopeKey || record.id !== streamId || record.definitionHash !== FORMAT_HASH || raw['format'] !== 1 || raw['streamId'] !== streamId
      || Object.keys(raw).some(key => !['format', 'streamId', 'timers'].includes(key)) || !Array.isArray(raw['timers']) || raw['timers'].length > TIMERS) throw new Error();
    const timers = raw['timers'].map(item => {
      const value = object(item); const base = definition({ id: value['id'], dueAtMs: value['dueAtMs'], ...(value['payload'] === undefined ? {} : { payload: value['payload'] }) });
      if (!['scheduled', 'fired', 'cancelled'].includes(value['status'] as string)
        || Object.keys(value).some(key => !['id', 'dueAtMs', 'payload', 'status', 'firedAtMs'].includes(key))) throw new Error();
      if (value['status'] === 'fired') {
        timestamp(value['firedAtMs']);
        if ((value['firedAtMs'] as number) < base.dueAtMs) throw new Error();
        return { ...base, status: 'fired' as const, firedAtMs: value['firedAtMs'] as number };
      }
      if (value['firedAtMs'] !== undefined) throw new Error();
      return { ...base, status: value['status'] as 'scheduled' | 'cancelled' };
    });
    if (new Set(timers.map(timer => timer.id)).size !== timers.length) throw new Error();
    return { format: 1, streamId, timers };
  } catch { throw new MayuraError('INTEGRITY_VIOLATION', 'Stored timer WorkStream data failed format or integrity validation.'); }
}

/** Finite durable timers. Applications explicitly schedule sweeps; this facade starts no background work. */
export function createTimerWorkStream(options: TimerWorkStreamOptions): TimerWorkStream {
  identifier(options.streamId); identifier(options.scope?.principalId); identifier(options.scope?.projectId);
  const streamId = options.streamId; const scope = { principalId: options.scope.principalId, projectId: options.scope.projectId };
  const store = options.store; const now = options.now ?? Date.now;
  let scopeKey: string | undefined; let initializePromise: Promise<void> | undefined;
  const currentTime = (): number => {
    let value: unknown;
    try { value = now(); } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'The trusted timer clock is unavailable.'); }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MayuraError('STORAGE_UNAVAILABLE', 'The trusted timer clock returned an invalid timestamp.');
    return value;
  };
  const storage = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof StorageError && error.code === 'CONFLICT') throw new MayuraError('CONFLICT', 'The timer WorkStream changed concurrently.');
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Timer WorkStream storage is unavailable; retry the same stable command after recovery.');
    }
  };
  const key = (): string => {
    if (!scopeKey) throw new MayuraError('INVALID_CONFIG', 'Initialize the timer WorkStream before accessing it.');
    return scopeKey;
  };
  const read = async (): Promise<{ record: StoredRecord; state: State }> => {
    const selected = key(); const record = await storage(() => store.read(selected, streamId));
    if (!record) throw new MayuraError('NOT_FOUND', 'Timer WorkStream was not found in the configured scope.');
    return { record, state: stateFrom(record, streamId, selected) };
  };
  const update = async <T>(transition: (state: State) => { result: T; events: readonly StoredEventInput[] }): Promise<T> => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const { record, state } = await read(); const changed = transition(state);
      if (changed.events.length === 0) return immutable(changed.result);
      let serialized: JsonObject;
      try { serialized = object(jsonValue(state, { maxBytes: STATE_BYTES })); }
      catch { throw new MayuraError('LIMIT_EXCEEDED', 'The bounded timer WorkStream state is full.'); }
      try {
        await store.update({ scope: key(), id: streamId, expectedVersion: record.version, state: serialized, events: changed.events });
        return immutable(changed.result);
      } catch (error) {
        if (error instanceof StorageError && error.code === 'CONFLICT') continue;
        throw new MayuraError('STORAGE_UNAVAILABLE', 'Timer WorkStream update could not be confirmed; retry the same stable command.');
      }
    }
    throw new MayuraError('CONFLICT', 'Timer WorkStream remained busy after bounded conflict retries.');
  };

  return Object.freeze<TimerWorkStream>({
    initialize: async () => {
      if (!initializePromise) initializePromise = (async () => {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mayura:timer-scope:v1\0${canonical(scope)}`));
        const selected = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const created = await storage(() => store.create({ scope: selected, id: streamId, idempotencyKey: streamId, definitionHash: FORMAT_HASH,
          state: { format: 1, streamId, timers: [] }, events: [{ type: 'timer-stream.created', data: {} }] }));
        stateFrom(created.record, streamId, selected); scopeKey = selected;
      })().catch((error: unknown) => { initializePromise = undefined; throw error; });
      await initializePromise;
    },
    schedule: async input => {
      const timer = definition(input);
      return update(state => {
        const existing = state.timers.find(item => item.id === timer.id);
        if (existing) {
          const comparable = { id: existing.id, dueAtMs: existing.dueAtMs, ...(existing.payload === undefined ? {} : { payload: existing.payload }) };
          if (!equal(jsonValue(comparable), jsonValue(timer))) throw new MayuraError('CONFLICT', 'Timer ID already identifies a different definition.');
          return { result: existing, events: [] };
        }
        if (state.timers.length >= TIMERS) throw new MayuraError('LIMIT_EXCEEDED', 'The timer retention limit was reached.');
        const scheduled: TimerSnapshot = { ...timer, status: 'scheduled' }; state.timers.push(scheduled);
        return { result: scheduled, events: [{ type: 'timer.scheduled', data: { timerId: timer.id, dueAtMs: timer.dueAtMs } }] };
      });
    },
    inspect: async id => {
      identifier(id); const { state } = await read(); const timer = state.timers.find(item => item.id === id);
      return timer ? immutable(timer) : undefined;
    },
    cancel: async id => {
      identifier(id);
      return update(state => {
        const index = state.timers.findIndex(timer => timer.id === id); const timer = state.timers[index];
        if (!timer) throw new MayuraError('NOT_FOUND', 'Timer was not found in this stream.');
        if (timer.status !== 'scheduled') return { result: timer, events: [] };
        const cancelled: TimerSnapshot = { ...timer, status: 'cancelled' }; state.timers[index] = cancelled;
        return { result: cancelled, events: [{ type: 'timer.cancelled', data: { timerId: id } }] };
      });
    },
    sweepDue: async (input = {}) => {
      const raw = object(jsonValue(input, { maxBytes: 1_024 }));
      if (Object.keys(raw).some(field => field !== 'limit')) throw new MayuraError('INVALID_INPUT', 'Timer sweep accepts only a bounded limit.');
      const limit = raw['limit'] === undefined ? 32 : raw['limit'];
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > TIMERS) throw new MayuraError('INVALID_INPUT', 'Timer sweep limit must be between 1 and 256.');
      const observedAtMs = currentTime();
      return update(state => {
        const eligible = state.timers.filter(timer => timer.status === 'scheduled' && timer.dueAtMs <= observedAtMs)
          .sort((left, right) => left.dueAtMs - right.dueAtMs || compareId(left.id, right.id)).slice(0, limit);
        if (eligible.length === 0) return { result: [] as TimerSnapshot[], events: [] };
        const ids = new Set(eligible.map(timer => timer.id)); const fired: TimerSnapshot[] = []; const events: StoredEventInput[] = [];
        state.timers = state.timers.map(timer => {
          if (!ids.has(timer.id)) return timer;
          const result: TimerSnapshot = { ...timer, status: 'fired', firedAtMs: observedAtMs }; fired.push(result);
          events.push({ type: 'timer.fired', data: { timerId: timer.id, dueAtMs: timer.dueAtMs, firedAtMs: observedAtMs } }); return result;
        });
        fired.sort((left, right) => left.dueAtMs - right.dueAtMs || compareId(left.id, right.id));
        return { result: fired, events };
      });
    },
    list: async (input = {}) => {
      const raw = object(jsonValue(input, { maxBytes: 1_024 }));
      if (Object.keys(raw).some(field => !['afterId', 'limit'].includes(field))) throw new MayuraError('INVALID_INPUT', 'Timer list accepts only cursor and limit.');
      const afterId = raw['afterId'] === undefined ? '' : raw['afterId'];
      if (afterId !== '') identifier(afterId);
      const limit = raw['limit'] === undefined ? 100 : raw['limit'];
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MayuraError('INVALID_INPUT', 'Timer page size must be between 1 and 100.');
      const { state } = await read(); const ordered = [...state.timers].sort((left, right) => compareId(left.id, right.id));
      const items = ordered.filter(timer => timer.id > afterId).slice(0, limit); const hasMore = ordered.some(timer => timer.id > (items.at(-1)?.id ?? afterId));
      return immutable({ items, next: hasMore ? items.at(-1)?.id ?? null : null });
    },
    events: async (after = 0) => {
      if (!Number.isSafeInteger(after) || after < 0) throw new MayuraError('INVALID_INPUT', 'Timer event cursor must be a nonnegative safe integer.');
      return immutable(await storage(() => store.events(key(), streamId, after)));
    },
  });
}
