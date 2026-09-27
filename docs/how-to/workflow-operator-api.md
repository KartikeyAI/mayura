# Production operator API for workflows

The agent server exposes workflow operations (index, views, cancel, approve, pause, resume, fleet sweeps and migrations) through transport callbacks. Writing those callbacks by hand means getting several things right every time:
- command idempotency across retries, replicas and restarts;
- revision checks;
- projecting each run on the definition version it is pinned to;
- index paging;
- scope isolation.

`createWorkflowOperatorTransports` provides all of them over the real format runtimes.

```ts
import { createWorkflowCommandJournal, createWorkflowFleetControl, createWorkflowMigrationCatalog, createWorkflowOperatorTransports,
  graphOperatorTarget, lifecycleOperatorTarget, treeOperatorTarget } from '@mayura/workflows';

const operator = createWorkflowOperatorTransports({
  store, scope,                                              // the one scope these transports serve
  journal: createWorkflowCommandJournal({ store, scope }),   // durable command idempotency
  fleet: createWorkflowFleetControl({ store, scope }),       // optional: hold, release and sweeps
  migrations: createWorkflowMigrationCatalog([releaseV1toV2]), // optional: reviewed migrations
  targets: [
    lifecycleOperatorTarget({ runtime: lifecycleFleet, store, scope, definitions: [releaseV1, releaseV2] }),
    graphOperatorTarget({ runtime: graphs, discovery: graphDiscovery, store, scope, definitions: [graphV1], approvalCredential }),
    treeOperatorTarget({ runtime: trees, discovery: treeDiscovery, store, scope, definitions: [treeV1], approvalCredential }),
  ],
});

await listenProductionServer({ /* ... */ ...operator });
```

`examples/deployment/app.mjs` and `examples/inspector.mjs` use it.

## What it guarantees

- **At most once per command id.** Every command is claimed in a durable journal before it acts, with a lease.
  - A retry with the same request gets the recorded outcome. For migrations, that includes the plan.
  - The same command id with a different request is a conflict.
  - A duplicate that arrives while the first attempt is still running is told to retry, instead of applying twice.
  - If an attempt dies mid-command, the next retry takes over once the lease expires (60 s by default). It first checks whether the effect already happened, and applies only if it did not. An attempt that fails with an ordinary error releases its lease at once.
- **Revision checks.** Commands apply only when the run is still at the revision the operator reviewed. The runtimes guard their own state transitions as well.
- **Multi-version views.** Each run is shown on the definition its stored state is pinned to, including after a migration. Register every version that still has runs; a run whose version is not registered is reported as not found.
- **Paging.** The index walks every target with opaque cursors. It lists active runs: running, waiting and paused.
- **Scope isolation.** A request authenticated for any other scope sees an empty index, gets `404` for runs, and gets an error for fleet operations. It changes nothing.
- **Approvals.** `approvalCredential` maps the authenticated operator to the credential your runtime's `verifyHuman` accepts. Without it, approvals are unavailable (`503`).
  - A tool step waiting for approval carries `approval: { digest, expiresAtMs }` in its view, so an operator approves over the API alone: `client.approveWorkflow(runId, { revision, nodeId, approvalDigest: step.approval.digest }, { commandId })`.
  - Lifecycle runs also show `approval.subject`: the tool id, version and exact validated input the approval binds. The runtime rebuilds it with `runtime.approvalRequest(definition, runId, nodeId)` and checks that it reproduces the digest. An input over 8 KiB is left out; the digest still identifies it.
  - An approval request lapses at `expiresAtMs` (the runtime's `approvalTtlMs`, 1 hour by default). The next pass re-requests it with a new digest, so approve the digest in the current view.
  - Every operator token for a scope authenticates as that scope's principal, so approvals are attributed to the service principal. Per-person attribution needs your identity provider in front of the API.

## Journal records

The journal keeps one small record per command id: a request digest, the outcome and an optional result of up to 256 KiB. Records are permanent. Command ids must be unique per run, for example a UUID per operator action, which is what the client and the operator console send.
