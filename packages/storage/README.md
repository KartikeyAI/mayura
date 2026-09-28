# mayura/storage

Compatibility facade for both Mayura SQL adapters. Development preview; not enterprise-qualified or published.

Existing imports remain supported:

```ts
import { createSqliteStore, createPostgresStore, StorageError } from 'mayura/storage';
```

This package deliberately installs both selected adapters. New applications that need only one database should use `mayura/storage-sqlite` or `mayura/storage-postgres` and import common types/errors from `mayura/storage-contracts`. Those explicit packages export the identical factory functions used here.

The shared SQL engine is implemented once in `mayura/storage-sql`. There is no persisted-format migration when changing this import to a selected adapter: use the same SQLite file or PostgreSQL schema. Driver-free SDK, workflows, WorkStream and custom storage consumers do not acquire SQL dependencies unless an adapter is explicitly installed.

Factory creation is synchronous; applications own `initialize()` and `close()`. Aggregate, scheduler, scheduled-workflow and completion-wait interfaces remain unchanged. Real-database and isolated package checks establish the current local evidence, not universal native compatibility or full enterprise qualification.

Both factories expose `initialize`, `create`, `read`, `update`, `events` and `close`. Updates use compare-and-set versions and append their events in the same transaction. Identical create retries compare the original submission, not its later mutable state. SQLite uses a dedicated storage-owning worker, WAL and full synchronization; PostgreSQL uses a bounded pool and transactional row locks.

## Experimental standalone scheduler

Both factories additionally expose `store.scheduler`. Initialize the containing store before initializing this capability; close only the containing store. They share its worker/pool and lifecycle.

```ts
import { createHash } from 'node:crypto';
import { createSqliteStore } from 'mayura/storage';

const store = createSqliteStore({ filename: './jobs.sqlite' });
await store.initialize();
await store.scheduler.initialize();
try {
  // This local fixture has no handler or external effect. Production scope and
  // candidate identity must come from the application's verified admission boundary.
  const intent = { toolId: 'demo.echo', callId: 'run-1/echo' };
  const candidateHash = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const { job } = await store.scheduler.reserve({
    scope: 'local-demo', jobId: 'job-1', reservationKey: 'request-1',
    runId: 'run-1', nodeId: 'echo', invocationId: 'run-1/echo',
    definitionHash: candidateHash, candidateHash, intent,
    resourceKeys: [], delayMs: 0,
  });
  console.log(job.state); // ready; reservation does not execute anything
} finally {
  await store.close();
}
```

The lifecycle is `reserve → claim → start → recordReceipt → complete`. Only a newly successful `start` grants one dispatch. A repeated start returns `already_started`, not another permit. Lost start acknowledgements must not be replayed. The store checks its own clock, worker identity, fence, expiry, cancellation and named resource holds on every authority transition.

`renew` cannot revive an expired generation. `cancel` and `recover` release never-started work; started uncertain work is never made ready again. Its resource holds remain quarantined. `recordReceipt` retains late/conflicting evidence independently from output disclosure; `receipts`, `read` and `events` do not execute work or renew a lease. `complete` requires known evidence and an already-admitted output from trusted application code.

This is a **trusted application-side ledger**, not an authentication service, financial budget account, tool broker, complete worker service or fencing wrapper for arbitrary workflow writes. Do not expose these methods directly to a model or untrusted client. Obtaining a standalone claim and then calling ordinary `AggregateStore.update` does not fence that update. Explicit `store.workflows` enrollment instead uses a separate atomic scheduled-workflow reducer and blocks ordinary writes to owned runs.

The standalone job ledger has hard bounds: 128 claim generations, 32 resource keys, 16 evidence records per generation, 64 successful control commands, 4 KiB intent, 64 KiB output and one MiB internal job state. Leases are 1–300 seconds. There is no automatic uncertain-effect retry, quarantine clearance or history compaction. An open store can retain late evidence; closing it or losing the process can leave an unknown result requiring later reconciliation.

In the source checkout, see the [aggregate contract](../../docs/guides/storage.md) and [scheduler specification](../../docs/guides/storage.md) for exact transactional, retry, clock, scope and qualification boundaries.
