# Wait for scheduled workflow completion

Use the optional `@mayura/workstream/executions` entry point to persist an `all` join over already-submitted scheduled-v1 workflows or scheduled-v2 graphs. The stream returns terminal metadata, not workflow outputs, prompts or receipts. Every target must use the same configured database, principal/project scope and pinned policy.

```ts
import { createExecutionWorkStream } from '@mayura/workstream/executions';

// The caller initialized and owns store. worker uses that same store and scope.
const reference = await worker.reference(run.id);
const joins = createExecutionWorkStream({
  store,
  scope,
  policyHash: reference.policyHash,
  streamId: 'deployment-joins',
});
await joins.initialize();
await joins.register({ id: 'release', targets: [reference] });

// Execute the target through its existing scheduled worker. This stream never executes it.
await worker.runUntilSettled(definition, run.id);
await joins.drainReady({ limit: 16 });
const completion = await joins.inspect('release');
await joins.close();
```

`resolved` means every target is terminal. Inspect each observation's `outcome`: failure, blocked, cancellation and `outcome_unknown` satisfy completion just as success does. Unknown effects require independent reconciliation; a completion wait never retries them. Access authorized workflow results separately through the workflow runtime.

Registration preserves target order and accepts 1–32 unique run IDs. Reuse the same wait ID and ordered references after an uncertain registration acknowledgment. Changed content under an existing ID conflicts. A stream retains at most 128 lifetime waits; cancellation does not free that capacity and never cancels target workflows.

`drainReady` is an explicit finite command, defaulting to 16 and capped at 32 resolved waits. There is no automatic polling, per-wait promise, worker slot or background notification subscription. Completion before registration works too. Closing the facade stops local commands without closing the caller's store or deleting persisted waits; a new facade can reopen the same stream.

Storage acknowledgments default to a 10-second timeout, with at most 64 actual pending adapter calls. Both limits are configurable within the documented bounds. A logical timeout does not imply rollback: inspect after an uncertain cancel/drain, and retry registration with the identical identity. An uncertain drain's returned page is not promised to be replayed. Custom adapters still occupy pending-call capacity until their actual promises settle.

Concurrent command replies can reflect earlier committed snapshots. The facade validates bounded metadata and pinned identities; it is not a replicated state cache or a substitute for an adapter's transactional integrity checks.

A workflow reference is immutable identity data, not an authorization capability or proof of database identity. Each command is checked against the configured scope and policy. These joins do not suspend nodes inside a workflow graph, own child workflows, propagate cancellation, implement `any`/timers, or provide durable event delivery.

For an actual node that suspends a graph and later feeds downstream work, use the separate [format-3 graph API](workflow-graph-waits.md). External streams and parent-owned graph waits share terminal facts, not mutable wait ownership.

The credential-free [SQLite close/reopen example](../../examples/execution-completion-waits.mjs) closes the stream, worker and database before resuming the target and resolving its persisted wait:

```sh
pnpm build
node examples/execution-completion-waits.mjs
```

It uses optional native SQLite storage; no database driver is added to the base SDK. See the [execution-completion contract](../specs/execution-completion-waits.md) for transaction guarantees and release boundaries.
