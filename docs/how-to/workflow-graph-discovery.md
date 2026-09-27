# Discover unfinished workflow graphs

Use `createWorkflowGraphDiscovery` when an application needs to find persisted format-3 graphs after losing its process-local run list. Discovery returns small continuation hints. It never runs tools, resolves waits, acquires execution leases or starts a background poller.

```ts
import { createWorkflowGraphDiscovery, createWorkflowGraphRuntime, type WorkflowGraphDiscoveryCursor } from 'mayura/workflows/graphs';

// Reuse only the shared policy fields; discovery does not accept worker-only options.
const policy = { scope, permissions, policyVersion: '1', maxCostMicros: 100 };
await store.initialize(); // Initialize application-owned storage before its optional capabilities.
const discovery = createWorkflowGraphDiscovery({ ...policy, store });
const worker = createWorkflowGraphRuntime({ ...policy, store, workerId: 'recovery' });
let cursor: WorkflowGraphDiscoveryCursor | null = null;
try {
  // The application owns its page/work budget and trusted definition registry.
  for (let pages = 0; pages < 10; pages++) {
    const page = await discovery.scan({ cursor, limit: 8 });
    for (const candidate of page.candidates) {
      const definition = definitions.get(candidate.reference.definitionHash);
      if (!definition) continue; // Arrange the right registered application code explicitly.
      await worker.runUntilSettled(definition, candidate.reference.runId);
    }
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  // If the page budget ends first, retain the cursor for an explicit later continuation.
} finally {
  await discovery.close();
  await worker.close();
  // Storage belongs to the application and remains open.
}
```

This snippet assumes a verified application-owned scope, selected SQL store, explicit grants and a map of genuine registered graph definitions keyed by their digest. Use the same policy version, limits, grants and approval lifetime as the original graph runtime. The standalone facade derives that exact policy hash; a cursor is not a substitute for authentication. Both selected SQL packages support the optional `workflowGraphDiscovery` capability. Existing custom graph stores do not gain it implicitly.

Run `node examples/workflow-graph-discovery.mjs` after building for a complete credential-free SQLite example. It closes all workers/storage, reopens without retaining the parent run list, finds one unfinished graph, skips a cancelled owner and resumes through the normal graph driver using a finite three-page sweep.

## What a page means

- `limit` defaults to 16 and permits 1–32 **examined ownership records**, not a guaranteed number of unfinished results.
- `candidates` contains only execution reference, observed version and `running`/`waiting` status. There are no inputs, outputs, errors, receipts or job payloads.
- `examined` includes terminal owners that were inspected but omitted from the candidate list.
- `nextCursor` advances over all examined records. An empty candidate array can still have a continuation. A full final page can require one extra empty call before `nextCursor` becomes null.

A hint is not proof that a graph is ready or still unfinished. Another worker may finish or cancel it immediately. A waiting graph can still have incomplete targets or pending human approval. The normal driver rechecks authority, state and grants; discovery never authorizes effect replay. Runs whose waits resolved before a crash interrupted downstream preparation/finalization remain discoverable.

## Bounds and operations

Pages are ordered by run ID using explicit binary/C collation. They do not share a stable database snapshot. New runs inserted before the cursor appear on a later caller-started sweep; continuous writes do not have a whole-sweep starvation guarantee. A complete sweep scales with retained ownership history, including terminal runs. This is a bounded recovery aid, not an efficient ready queue or history-retention service.

Index provisioning is explicit capability initialization, performed lazily by the public facade. Existing owned runs require no projection backfill. Native index creation can scan old history and hold database locks: PostgreSQL applies its configured statement/lock limits; SQLite's busy timeout is a lock-wait limit, not an index-build CPU deadline. Initialization failure is reported, with no deliberately unindexed fallback.

A same-named index with incompatible table, columns, ordering, collation or partial/invalid definition is rejected using native catalog checks. It is not silently replaced. This startup validation does not continuously monitor privileged schema changes.

The database still chooses the physical query plan. A compatible index is required, but its presence and the page limit are not a guarantee of physical rows visited or query latency. PostgreSQL's snapshot-specific index eligibility is left to PostgreSQL; a legitimate HOT-chain visibility flag is not treated as index corruption.

`storageTimeoutMs` bounds each local acknowledgement wait; `maxPendingStorageOperations` bounds actual adapter callbacks. Timed-out callbacks retain those slots until their real promises settle. Closing the facade rejects new work and local waits but cannot interrupt an already-running database operation. Applications must separately bound concurrent `scan()` callers, including callers sharing initialization, and choose their own page/work budgets. No production latency bound or fleet behavior is implied.

See the [discovery contract](../specs/workflow-graph-discovery.md), [graph wait guide](workflow-graph-waits.md) and [development ledger](../development-status.md). Public packages remain private development artifacts pending release qualification and owner distribution decisions.
