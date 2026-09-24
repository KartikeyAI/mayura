# Scheduled workflows

Experimental, opt-in finite execution for the reference SQLite and PostgreSQL adapters. The API couples job claims, exact approvals, workflow state and fixed-cost accounting in short atomic transactions. It is not a complete distributed worker service or an exactly-once guarantee for external systems.

## Choose the execution profile

- `createWorkflowRuntime`: existing conservative format-2 driver; explicit no-replay recovery without leases.
- `createScheduledWorkflowRuntime`: new scheduled profile; atomic ownership, renewable claims, explicit resource exclusion and conservative expiry handling.
- `workflowAsAgent` / `workflowAsTool`: separate process-local, approval-free composition through the agent runtime. These do not create durable jobs.

Nothing is automatically migrated. Both durable profiles use the same finite `defineWorkflow` graphs. Scheduled input and each admitted output are limited to 64 KiB; the conservative driver's default is 1 MiB.

## Minimal adoption

Import workflow APIs from `@mayura/workflows`, tools from `@mayura/tools`, and an explicitly chosen reference adapter from `@mayura/storage`. Packages are still private development builds; registry installation/publication is not yet available.

```ts
import { createSqliteStore } from '@mayura/storage';
import { createScheduledWorkflowRuntime } from '@mayura/workflows';

const store = createSqliteStore({ filename: './mayura.sqlite' });
await store.initialize();
const worker = createScheduledWorkflowRuntime({
  store,
  workerId: 'worker-a',
  scope: { principalId: 'service-a', projectId: 'project-a' },
  permissions: { allow: ['tool:calculate'] },
  policyVersion: '1',
  maxCostMicros: 100,
});

// definition is a versioned defineWorkflow(...) graph with explicit schemas and tools.
const run = await worker.submit(definition, {
  input: { amount: 21 },
  idempotencyKey: 'request-123',
});
const state = await worker.runUntilSettled(definition, run.id);
await worker.close();
await store.close();
```

The complete credential-free [example](../packages/workflows/examples/scheduled-workflow.mjs) creates a disposable SQLite database, executes a schema-validated tool, closes and reopens the database, and verifies that the result is restored without replay. From the workspace root, run `pnpm build`, then `node packages/workflows/examples/scheduled-workflow.mjs`. Its cleanup removes only its newly created temporary database directory.

`runUntilSettled` is a finite drain, not an always-running poller. It returns when this call cannot progress or the run reaches a terminal status. Another worker's active job, an external resource hold, or a pending review may leave the run `running`/`waiting`. Arrange an explicit subsequent call through the application's bounded control loop; do not assume every return means success or automatically resubmit an unknown effect.

## External-effect reconciliation

Configure `verifyExecution` only with an application-owned adapter that can authenticate and authoritatively inspect the external provider. When a started tool attempt ends in `outcome_unknown`, call `reconcile(definition, { id, nodeId, credential })`. The verifier receives a frozen description of the exact persisted attempt and returns a stable authority/attestation identity, known execution result and verified total cost. The credential and raw provider response never persist; storage retains the authority and a digest of the attestation identity.

The receipt and exact cost settlement commit atomically. A repeated identical attestation is idempotent and contradictory known evidence cannot replace the first known fact. Reconciliation does not release output, continue dependent nodes, replay the effect or clear resource quarantine; the workflow remains in its terminal state. See the [normative contract](specs/external-effect-reconciliation.md).

## Approvals, resources and restart

Set `approval: true` on a tool node and supply `verifyHuman` on the worker. The verifier must authenticate the credential and return a trusted human ID, matching project ID and approval authority. Present the current `steps[nodeId].approval.digest` to that human, then pass it with the credential to `worker.approve({ id, nodeId, digest, credential })`. Credentials never enter durable commands or history. Approvals bind exact validated input, tool/version, policy and storage-assigned expiry.

Waiting reviews reserve no money or job. If an already prepared job's review expires before start, it is blocked and its unspent reservation is released. This first profile requires a new submission after that block; it does not silently replace the approval or prepared job.

`resources: { deploy: ['environment:staging'] }` pins exact resource identities per tool node. They are shared within the same principal/project-derived storage scope, not across different principals. Resource aliases, file paths and provider object identities are not inferred. Unknown started effects retain quarantine even if verified reconciliation settles their exact cost; resource clearance requires a separate qualified policy.

Use the same scope, permissions, policy version, limits, definition and resource map when reopening a run. `inspect`, `events`, `cancel` and `recoverExpired` are explicit operations. An expired never-started lease may be reclaimed without reserving twice. A started invocation is never automatically replayed.

`attach(definition, id)` is available only for pristine existing format-2 runs with an identical policy, including a compatible output limit. Runs with approvals, reservations, receipts or dispatched work cannot be attached. Once enrolled, ordinary aggregate writes and standalone scheduler mutations of that run fail closed. The deployment must stop unsupported old adapter binaries and privileged direct writers; a sidecar does not control external SQL access.

## Bounds and shutdown

| Setting | Default | Supported bound |
| --- | --- | --- |
| `leaseMs` | 3,000 | 1,000–300,000 |
| `maxConcurrentJobs` | 4 | 1–32 per worker |
| `maxConcurrentRuns` | 16 | 1–128 per worker |
| `storageTimeoutMs` | 10,000 | 1–30,000 per adapter wait |
| `maxPendingStorageOperations` | 64 | 1–1,024 actual pending adapter callbacks |
| `reconciliationTimeoutMs` | 30,000 | 1–30,000 per external verifier call |
| `maxOutputBytes` | 65,536 | 1–65,536 |

All counters must be integers. An uncertain handler retains its local executor slot until the actual callback settles. A timed-out adapter callback also retains its capacity slot until actual settlement; repeated timeouts cannot create unlimited pending adapter calls. Storage timeout means the commit may be uncertain, not that an operation was rolled back. Late claim/start acknowledgements never grant dispatch.

`close()` stops this worker's waits and local cooperative execution, not the shared run. Use `cancel(id)` for durable cancellation. The caller owns the store lifecycle; late known receipts can still be persisted while that store remains open. If the process/store is lost first, reconciliation may remain necessary. Trusted synchronous callbacks can block the JavaScript event loop; these limits are not a hard sandbox.

Only released, schema-validated output reaches successor nodes. Successful effects followed by blocked output remain successful effects with withheld disclosure. A cancelled or expired attempt cannot resurrect output through a late result.

The complete aggregate also has a 1 MiB bound, independently of each 64 KiB value. Output admission leaves conservative space for future receipts, review identities and cancellation/accounting metadata. An oversized join fails deterministically; a successful tool whose output cannot fit is marked blocked with its successful effect receipt withheld; an oversized final result fails finalization. Existing effect facts and costs remain intact rather than trapping the run in repeated storage errors.

## Storage contract and qualification

Custom adapters must implement the finite `ScheduledWorkflowStore` commands as atomic transactions and pass the [scheduled conformance suite](testing-scheduled-workflows.md). Do not implement them by chaining public aggregate/scheduler calls. The detailed [implementation contract](specs/scheduled-workflows.md) defines ownership, lock order, evidence, command deduplication and legacy compatibility.

Command journals are finite (1,024 state-changing commands per run); scheduler attempt/evidence/command limits remain independent. Pure no-op `advance`, `recover` and already-terminal `cancel` transitions do not append history or retain command IDs. There is no silent history eviction, general migration API or built-in provider adapter. Durable child composition, WorkStream execution waits, timers, transactional outbox, fleet management and complete production qualification remain open.
