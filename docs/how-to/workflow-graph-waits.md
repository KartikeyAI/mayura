# Wait inside a durable workflow graph

Use `@mayura/workflows/graphs` when a workflow must pause until previously submitted scheduled runs reach a terminal outcome, then continue its own tool/join nodes. This explicit format-3 API is separate from legacy `defineWorkflow`; it needs an adapter with the optional `workflowGraphs` capability. Both selected SQL adapters provide it.

```ts
import { defineWorkflowGraph, createWorkflowGraphRuntime } from '@mayura/workflows/graphs';

const release = defineWorkflowGraph({
  id: 'release', version: '1', input: releaseInputSchema, output: completionListSchema,
  nodes: [{
    id: 'dependencies', kind: 'wait',
    targets: { kind: 'input', path: ['references'] },
  }],
  result: { kind: 'step', stepId: 'dependencies', path: [] },
});
const worker = createWorkflowGraphRuntime({
  store, scope, workerId: 'release-worker', permissions: { allow: [] },
  policyVersion: '1', maxCostMicros: 0,
});
const reference = await sourceWorker.reference(existingRun.id);
const run = await worker.submit(release, {
  input: { references: [reference] }, idempotencyKey: 'release-42',
});
const current = await worker.runUntilSettled(release, run.id);
// `waiting` is a durable state, not a held Promise or executor slot.
// After source workers make progress, call runUntilSettled again with the same definition/id.
await worker.close(); // The application still owns store.close().
```

The snippet assumes application-owned Standard Schemas, verified `scope`, store and an already submitted target. Run `node examples/workflow-graph-waits.mjs` after building for a complete credential-free SQLite example that closes every local owner while waiting and resumes after reopen.

## Target and result rules

Targets are exact `ExecutionRef` records from an existing scheduled-v1 or scheduled-v2 run in the same backend, principal/project scope and pinned policy. Keep scope, policy version, grants, cost/output limits and approval expiry configuration consistent: policy hashes cover all of those settings. A reference carries identity metadata, not authority, a remote backend locator or a promise that a target succeeded.

Each wait has 1–32 unique ordered targets; a graph has at most 128 total target edges and 128 nodes, subject to JSON/output bounds. Targets resolve from admitted immutable input or a literal at submission. Step-output/future references and attaching a graph to an existing run are intentionally unsupported. This pins dependencies before parent creation and prevents admitted cross-run cycles without a global graph scan. Input schema transforms run before targets are resolved.

Literal bindings accept the references returned by `worker.reference()` directly: `targets: { kind: 'literal', value: [reference] }`. Readonly reference arrays are supported; no JSON cast or schema-library-specific wrapper is needed. Every value still receives runtime validation and immutable ownership.

A wait succeeds after every target is terminal, including `failed`, `blocked`, `cancelled` or `outcome_unknown`. Its output is an ordered `ExecutionCompletion[]`: reference, terminal outcome and observed source version/event sequence. It contains no target output, errors or receipts. Inspect each outcome before deciding on follow-up work; observing unknown is never permission to replay that target. A successful wait reports successful observation, not success of the observed effects.

Normal tool and join nodes can declare the wait ID in `dependsOn` and bind its admitted metadata with `{ kind: 'step', stepId, path }`. They retain the ordinary permission checks, approval, fixed-cost reservation, fenced dispatch and output admission. The wait itself runs no handler and creates no job, reservation, lease or resource hold. Result schema validation still gates final graph success.

## Recovery and boundaries

Repeated unchanged advances do not consume events, versions or the command journal. Concurrent drivers serialize transitions; closing one driver does not cancel the persisted graph. Cancelling the parent skips its unresolved waits and leaves targets untouched. A terminal parent cannot resume after late target completion. Known late target evidence cannot rewrite an immutable unknown completion observation.

Drive calls are finite. There is no automatic polling, timer service or notification worker. This is not durable child ownership: the parent does not spawn targets, share their budgets, propagate cancellation, or return their payloads. Durable workflows-as-tools, timers/any waits, dynamic branches and distributed orchestration remain separate work.

Custom adapters are trusted persistence implementations. Public responses receive bounded structural and contextual checks; execution with a registered definition additionally checks manifest/target consistency. Inspection alone has no supplied definition and does not cryptographically authenticate database facts. The reference SQL implementations additionally verify parent projections against the immutable target index and completion facts.

See the [transaction/version contract](../specs/workflow-graph-waits.md), [selected storage guide](storage-installation.md) and [development ledger](../development-status.md) for precise evidence and remaining release gates. Packages remain private development artifacts, not a published enterprise release.
