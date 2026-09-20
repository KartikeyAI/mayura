# Continue explicitly registered workflow graphs

`createWorkflowGraphCoordinator` combines finite discovery with one shared graph driver. The application registers trusted definitions and immutable resource plans, calls one page at a time, and decides whether and when to continue. It does not submit graphs, approve actions, own child executions or run a background service.

```ts
import { createWorkflowGraphCoordinator } from '@mayura/workflows/graphs';

await store.initialize();
const coordinator = createWorkflowGraphCoordinator({
  store, scope, permissions, policyVersion: '1', maxCostMicros: 100,
  workerId: 'recovery', maxConcurrentJobs: 2,
  definitions: [
    { definition: releaseGraph, resources: releaseResources },
    { definition: reviewGraph }, // Explicitly uses the empty resource plan.
  ],
});
try {
  const report = await coordinator.runPage({ limit: 8 });
  for (const outcome of report.outcomes) {
    if (outcome.kind === 'observed') {
      console.log(outcome.reference.runId, outcome.status, outcome.version);
    }
  }
  if (report.status === 'completed') {
    // Persist report.nextCursor to continue this sweep; null means exhausted.
  } else {
    // Investigate report.code and retain report.retryCursor for explicit retry.
    // Do not move to the end of this partially processed page.
  }
} finally {
  await coordinator.close(); // The application still owns storage and durable runs.
}
```

The snippet assumes genuine registered graph definitions, an initialized store with both graph and graph-discovery capabilities, a verified application-owned scope, and explicit grants. Policy and each definition's resource plan must match the original submission. Run `node examples/workflow-graph-coordinator.mjs` after building for a complete credential-free SQLite example with restart, two registered definitions, an unfinished wait, an unregistered definition and an explicit second sweep.

## Catalog and authority

Register 1–32 genuine definitions. The catalog snapshots metadata and resource plans before asynchronous work and permits at most 4 MiB of cumulative canonical manifest/resource metadata, in addition to existing per-definition limits. Duplicate manifest digests are rejected, even when definition objects or callbacks differ. A catalog is not dynamically extended: create a separately configured coordinator when application registration changes.

Each digest has exactly one resource plan. Omitting `resources` means the empty plan, not “read the plan from storage.” There is no global resource fallback. Runs with another plan cannot silently change locks, grants or handlers. The manifest digest does not attest schema, guard or handler implementation bytes; applications must version behavioral changes explicitly.

One shared driver owns actual job and pending-storage capacity across definitions and pages. Definitions are not separate workers with multiplied limits. Candidates are driven sequentially; existing tool branches may use the configured job concurrency. `maxCostMicros` is the policy limit of each independent root run, not a shared page spending allowance. Discovery and driver storage callbacks have separate configured counters; timed-out callbacks retain their own capacity until they actually settle. This is not a universal quota for arbitrary schema callbacks.

## Reports and continuation

`limit` defaults to 16 and accepts 1–32 examined ownership records, including terminal owners. Reports contain frozen metadata only: no graph inputs, outputs, receipts or exception messages. Every discovered candidate has one ordered outcome:

| Kind | Meaning |
| --- | --- |
| `observed` | Driver returned the current version/status; this can still be `running` or `waiting`. |
| `skipped` | The digest is unregistered; no driver dispatch occurred. |
| `failed` | This candidate's driver call failed; only a closed public error code is disclosed. |
| `not_attempted` | An earlier failure or close stopped the page before this candidate. |

Invalid commands, overlapping page calls and discovery failures reject before dispatch. There is no page queue. After discovery succeeds, the first driver failure interrupts the page, preserving earlier observations and marking the remaining candidates unattempted. Interrupted reports expose the original owned `retryCursor` and no `nextCursor`. Retrying may revisit earlier committed candidates: the existing driver reconciles durable evidence; a page report never grants permission to replay effects.

A completed report can advance past unknown definitions and graphs that remain waiting/running. To revisit those, the application must explicitly begin another sweep from `cursor: null`. Pages do not share a database snapshot, and exhausted discovery is not a claim that all workflows are finished. A full final page can require another empty call; empty candidate pages can still carry a cursor. See [discovery semantics](workflow-graph-discovery.md) for index and retention limitations.

Closing stops admission synchronously. Before successful discovery, pending page work rejects with `CANCELLED`; after discovery, close returns a partial interrupted report, preserving prior observations and unattempted candidates. A report already synchronously frozen and published is not rewritten by later close. Close waits for logical driver shutdown, not indefinitely unresolved trusted handlers, and does not cancel durable runs, their targets or application-owned storage. Underlying callbacks may still settle later.

See the [coordinator contract](../specs/workflow-graph-coordinator.md), [graph waits](workflow-graph-waits.md) and [development ledger](../development-status.md). This finite facade is not a polling scheduler, distributed worker fleet or enterprise-qualified release.
