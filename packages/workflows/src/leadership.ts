import { freezeJson, jsonValue, MayuraError, type JsonObject, type Scope } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredRecord } from '@mayura/storage-contracts';
import { digest } from './definition.js';

export interface WorkflowLeadershipState {
  readonly leader: boolean;
  /** Increments on every change of holder; a lower fence can never regain leadership without a new acquisition. */
  readonly fence: number;
  readonly holderId: string | null;
  readonly expiresAtMs: number;
}
export interface WorkflowLeadership {
  /** Acquire, renew or observe the lease in one compare-and-set step. */
  acquire(): Promise<WorkflowLeadershipState>;
  /** Give up the lease immediately if held, so a standby can take over without waiting for expiry. */
  release(): Promise<void>;
  /** Local view: true only while the last confirmed lease has more than a third of its duration left. */
  isLeader(): boolean;
}
export interface WorkflowLeadershipOptions {
  readonly store: AggregateStore;
  readonly scope: Scope;
  /** Separates independent duties in one scope, for example `lifecycle-host` and `composite-host`. */
  readonly role: string;
  readonly holderId: string;
  /** Lease duration; replicas' clocks must agree to within a third of it. Default 15 s, 3 s–10 min. */
  readonly leaseMs?: number;
  readonly now?: () => number;
}

interface LeaseState { format: 1; holderId: string; fence: number; expiresAtMs: number }
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * Durable lease for one duty in one scope. It prevents duplicated host work across replicas; it is not the
 * correctness mechanism — format runtimes stay safe under concurrent drivers through their own CAS and claims.
 */
export function createWorkflowLeadership(options: WorkflowLeadershipOptions): WorkflowLeadership {
  const { store } = options; const leaseMs = options.leaseMs ?? 15_000;
  if (!store || typeof store.read !== 'function' || typeof store.create !== 'function' || typeof store.update !== 'function'
    || typeof options.role !== 'string' || !identifier.test(options.role) || typeof options.holderId !== 'string' || !identifier.test(options.holderId)
    || !Number.isSafeInteger(leaseMs) || leaseMs < 3_000 || leaseMs > 600_000) throw new MayuraError('INVALID_CONFIG', 'Leadership requires a store, bounded role/holder identities and a 3 s–10 min lease.');
  const scope = digest('mayura:scope:v1', { principalId: options.scope?.principalId, projectId: options.scope?.projectId });
  const id = digest('mayura:workflow-leadership:v1', { scope, role: options.role }); const holderId = options.holderId;
  const now = (): number => {
    const value = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('STORAGE_UNAVAILABLE', 'The trusted leadership clock returned an invalid timestamp.');
    return value;
  };
  let confirmed: { fence: number; expiresAtMs: number } | null = null;
  const leaseFrom = (record: StoredRecord | undefined): LeaseState | undefined => {
    if (!record) return undefined; const state = record.state;
    if (record.scope !== scope || record.id !== id || state['format'] !== 1 || typeof state['holderId'] !== 'string' || !identifier.test(state['holderId'])
      || !Number.isSafeInteger(state['fence']) || (state['fence'] as number) < 1 || !Number.isSafeInteger(state['expiresAtMs']) || (state['expiresAtMs'] as number) < 0) {
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored leadership lease failed integrity validation.');
    }
    return { format: 1, holderId: state['holderId'], fence: state['fence'] as number, expiresAtMs: state['expiresAtMs'] as number };
  };
  const publicState = (lease: LeaseState | undefined, leader: boolean): WorkflowLeadershipState => freezeJson(jsonValue({
    leader, fence: lease?.fence ?? 0, holderId: lease && lease.expiresAtMs > now() ? lease.holderId : null, expiresAtMs: lease?.expiresAtMs ?? 0,
  })) as unknown as WorkflowLeadershipState;
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) { if (error instanceof MayuraError || (error instanceof StorageError && error.code === 'CONFLICT')) throw error;
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Leadership storage is unavailable.'); }
  };
  return Object.freeze<WorkflowLeadership>({
    async acquire() {
      for (let attempt = 0; attempt < 8; attempt++) {
        const record = await guarded(() => store.read(scope, id)); const lease = leaseFrom(record); const observedAtMs = now();
        const mine = lease?.holderId === holderId && lease.expiresAtMs > observedAtMs;
        if (lease && !mine && lease.expiresAtMs > observedAtMs) { confirmed = null; return publicState(lease, false); }
        // Renewal keeps the fence; any change of holder (or a lapsed lease) advances it.
        const next: LeaseState = { format: 1, holderId, fence: mine ? lease.fence : (lease?.fence ?? 0) + 1, expiresAtMs: observedAtMs + leaseMs };
        const event = { type: mine ? 'leadership.renewed' : 'leadership.acquired', data: { fence: next.fence } };
        try {
          if (!record) {
            const created = await store.create({ scope, id, idempotencyKey: id, definitionHash: digest('mayura:workflow-leadership-format:v1', {}),
              state: jsonValue(next) as JsonObject, events: [event] });
            if (!created.created) continue;
          } else await store.update({ scope, id, expectedVersion: record.version, state: jsonValue(next) as JsonObject, events: [event] });
          confirmed = { fence: next.fence, expiresAtMs: next.expiresAtMs }; return publicState(next, true);
        } catch (error) {
          if (error instanceof StorageError && error.code === 'CONFLICT') continue;
          confirmed = null; throw new MayuraError('STORAGE_UNAVAILABLE', 'Leadership lease update could not be confirmed.');
        }
      }
      confirmed = null; throw new MayuraError('CONFLICT', 'Leadership lease remained contended after bounded retries.');
    },
    async release() {
      const held = confirmed; confirmed = null; if (!held) return;
      for (let attempt = 0; attempt < 8; attempt++) {
        const record = await guarded(() => store.read(scope, id)); const lease = leaseFrom(record);
        if (!record || !lease || lease.holderId !== holderId || lease.fence !== held.fence) return;
        try { await store.update({ scope, id, expectedVersion: record.version, state: jsonValue({ ...lease, expiresAtMs: 0 }) as JsonObject,
          events: [{ type: 'leadership.released', data: { fence: lease.fence } }] }); return; }
        catch (error) { if (!(error instanceof StorageError && error.code === 'CONFLICT')) throw new MayuraError('STORAGE_UNAVAILABLE', 'Leadership release could not be confirmed.'); }
      }
    },
    isLeader: () => confirmed !== null && now() < confirmed.expiresAtMs - Math.floor(leaseMs / 3),
  });
}
