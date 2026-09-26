import { MayuraError, type JsonValue, type Scope } from '@mayura/core';
import type { AggregateStore } from '@mayura/storage-contracts';
import { digest } from './definition.js';
import type { WorkflowCompositeFleetRuntime } from './composite-fleet.js';

/**
 * Definition-version policy. A durable run is pinned to its definition digest. A deployment either keeps every
 * digest that still has active runs registered with its hosts (versions run side by side), or drains, or cancels
 * those runs first. Mayura never interprets stored state with a different definition. This inventory is how
 * operators and deploy gates see which versions are still required.
 */
/** Read-only discovery for one format. Every `WorkflowFleetTarget` is also a version target. */
export interface WorkflowVersionTarget {
  readonly name: string;
  discover(cursor: JsonValue | null, limit: number): Promise<{ readonly runIds: readonly string[]; readonly nextCursor: JsonValue | null }>;
  inspect(runId: string): Promise<{ readonly status: string }>;
}
export interface WorkflowVersionEntry {
  readonly definitionHash: string;
  /** Non-terminal runs (running, waiting or paused) pinned to this digest. */
  readonly activeRuns: number;
  readonly registered: boolean;
  readonly targets: readonly string[];
}
export interface WorkflowVersionInventory {
  readonly versions: readonly WorkflowVersionEntry[];
  /** Active digests no registered definition can execute: deploying without them strands runs. */
  readonly unregistered: readonly string[];
  /** Registered digests with no active run: safe to retire once new submissions use the new version. */
  readonly retirable: readonly string[];
  /** False when a bound stopped the scan early; a gate must not pass an incomplete inventory. */
  readonly complete: boolean;
  readonly scanned: number;
}
export interface WorkflowVersionInventoryOptions {
  readonly store: AggregateStore;
  readonly scope: Scope;
  /** Every format's discovery; paused runs must be included (see `lifecycleFleetTarget(..., { includePaused: true })`). */
  readonly targets: readonly WorkflowVersionTarget[];
  /** Definitions (or digests) the next deployment will register. */
  readonly registered: readonly ({ readonly digest: string } | string)[];
  /** Maximum runs examined across all targets (default 10,000; maximum 1,000,000). */
  readonly maxRuns?: number;
  readonly pageLimit?: number;
}

const hashPattern = /^[a-f0-9]{64}$/;
const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown', 'compensated', 'limit_exceeded']);

/** Count active runs per pinned definition digest across the given format targets. Read-only. */
export async function inventoryWorkflowVersions(options: WorkflowVersionInventoryOptions): Promise<WorkflowVersionInventory> {
  const { store } = options;
  if (!store || typeof store.read !== 'function' || !Array.isArray(options.targets) || options.targets.length > 32 || !Array.isArray(options.registered)) {
    throw new MayuraError('INVALID_CONFIG', 'A version inventory requires a store, 0–32 fleet targets and the registered definitions.');
  }
  const maxRuns = options.maxRuns ?? 10_000; const pageLimit = options.pageLimit ?? 128;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 1_000_000 || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 1_000) {
    throw new MayuraError('INVALID_CONFIG', 'Inventory bounds are outside their limits.');
  }
  const registered = new Set(options.registered.map(entry => {
    const value = typeof entry === 'string' ? entry : entry?.digest;
    if (typeof value !== 'string' || !hashPattern.test(value)) throw new MayuraError('INVALID_CONFIG', 'Registered definitions must carry a 64-hex digest.');
    return value;
  }));
  const scopeKey = digest('mayura:scope:v1', { principalId: options.scope?.principalId, projectId: options.scope?.projectId });
  const counts = new Map<string, { activeRuns: number; targets: Set<string> }>(); const seen = new Set<string>();
  let scanned = 0; let complete = true;
  for (const target of options.targets) {
    let cursor: JsonValue | null = null;
    do {
      if (scanned >= maxRuns) { complete = false; break; }
      const page: { readonly runIds: readonly string[]; readonly nextCursor: JsonValue | null } = await target.discover(cursor, Math.min(pageLimit, maxRuns - scanned));
      for (const runId of page.runIds) {
        if (seen.has(`${target.name}:${runId}`)) continue; seen.add(`${target.name}:${runId}`); scanned++;
        const status = (await target.inspect(runId)).status;
        if (terminal.has(status)) continue;
        const record = await store.read(scopeKey, runId);
        if (!record || !hashPattern.test(record.definitionHash)) { complete = false; continue; }
        const entry = counts.get(record.definitionHash) ?? { activeRuns: 0, targets: new Set<string>() };
        entry.activeRuns++; entry.targets.add(target.name); counts.set(record.definitionHash, entry);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  const versions = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([definitionHash, entry]) => Object.freeze({
    definitionHash, activeRuns: entry.activeRuns, registered: registered.has(definitionHash), targets: Object.freeze([...entry.targets].sort()) }));
  return Object.freeze({
    versions: Object.freeze(versions),
    unregistered: Object.freeze(versions.filter(entry => !entry.registered).map(entry => entry.definitionHash)),
    retirable: Object.freeze([...registered].filter(hash => !counts.has(hash)).sort()),
    complete, scanned,
  });
}

/** Deploy gate: throws unless the inventory is complete and every active digest stays registered. */
export function assertWorkflowVersionsRetained(inventory: WorkflowVersionInventory): void {
  if (!inventory.complete) throw new MayuraError('LIMIT_EXCEEDED', 'The workflow version inventory is incomplete; raise maxRuns before deploying.');
  if (inventory.unregistered.length > 0) {
    throw new MayuraError('CONFLICT', `Active workflow runs are pinned to ${inventory.unregistered.length} definition version(s) the deployment does not register. Keep them registered, or drain or cancel those runs first.`);
  }
}

/** Saga and loop runs from the composite fleet index, for inventories. */
export function compositeVersionTarget(runtime: WorkflowCompositeFleetRuntime, name = 'composites'): WorkflowVersionTarget {
  const kinds = new Map<string, 'saga' | 'loop'>();
  return Object.freeze({ name,
    discover: async (cursor: JsonValue | null, limit: number) => {
      const page = await runtime.scan({ cursor: cursor as never, limit: Math.min(limit, 128) });
      for (const candidate of page.candidates) kinds.set(candidate.runId, candidate.kind);
      return { runIds: page.candidates.map(candidate => candidate.runId), nextCursor: page.nextCursor as unknown as JsonValue | null };
    },
    inspect: async (runId: string) => kinds.get(runId) === 'loop' ? runtime.loops.inspect(runId) : runtime.sagas.inspect(runId),
  });
}
