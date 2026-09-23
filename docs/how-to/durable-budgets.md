# Share a budget across restarts

The optional `store.durableBudgets` capability persists a bounded financial/call ledger on selected SQLite or PostgreSQL storage. It is a trusted-host primitive, not an agent executor: existing scheduled workflows do not automatically use it, and account IDs or policy hashes do not grant permissions.

```ts
await store.initialize();
await store.durableBudgets.initialize();
const key = { scope: verifiedScope, id: 'job-budget', policyHash };
await store.durableBudgets.create({ ...key, maxCostMicros: 100, maxCalls: 8 });
await store.durableBudgets.fork({
  ...key, parentId: 'root', accountId: 'review', maxCostMicros: 40, maxCalls: 2,
});
await store.durableBudgets.reserveBundle({
  ...key, accountId: 'review', bundleId: 'review-pair',
  operations: [
    { id: 'primary', maxCostMicros: 30 },
    { id: 'required-check', maxCostMicros: 10 },
  ],
});
const reservation = { ...key, accountId: 'review', reservationId: 'primary' };
const start = await store.durableBudgets.start(reservation);
if (start.status === 'already_started') {
  // Observe/reconcile the original operation. Do not execute it again.
}
// Once the trusted host has confirmed cost evidence:
const settled = await store.durableBudgets.settle({ ...reservation, actualMicros: 24 });
if (settled.overrun) {
  // Full usage is already committed. Further admissions across this ledger are blocked.
}
```

The snippet demonstrates accounting only; it deliberately contains no external effect dispatch. A complete execution host must couple the ledger to durable invocation identity, authority, leases/fences and evidence in the SAME transaction before it can advertise restart-safe child execution. Independently calling a workflow API and this ledger is not that integration. Use an application-owned authenticated scope and immutable policy digest, not model-supplied authority.

`node examples/durable-budgets.mjs` runs a complete credential-free SQLite example after building. It closes a subtree with unknown cost, reopens storage, confirms the historical start and records late known usage without executing any tool or model.

## Shared ceilings, not duplicated funds

Every root has a `root` account. Forked accounts set local ceilings without reserving money or promising prepaid capacity. Each reservation atomically consumes the same root-to-account capacity, so siblings cannot spend the same remaining balance. A bundle protects 1–32 future calls together; either every hold commits or none do. Zero-cost operations still consume call capacity.

Account snapshots include descendant usage. Never add parent and child totals together. `heldCalls` are future calls; starting converts one to permanently consumed `calls`. Known settlement releases the reservation bound and records full actual cost. Per-operation costs are nonnegative safe integers; cumulative spending beyond JavaScript's safe integer range is returned as an exact decimal string.

An overrun is a successful evidence write with `overrun: true` and `snapshot.blocked: true`, not a failed transaction. It blocks new accounts, reservations and starts anywhere in the ledger. Other started/unknown reservations still accept known late settlement. The ledger verifies arithmetic and identity, not whether the host's supplied evidence is a true provider invoice.

## Unknown usage, closure and retries

- `markUnknown` preserves the full monetary reservation and historical call. No elapsed timeout, disconnect, restart or close is evidence of zero cost.
- `cancelReservation` releases only held work. It cannot refund started, unknown or settled reservations.
- `closeSubtree` durably closes admission below one account and cancels its held reservations atomically. Siblings remain open. Started/unknown funds and consumed calls survive. This intentionally combines closure and held cleanup; core `Budget.close()` alone does not release held tickets.
- Repeated exact root/account/bundle creation returns current history without adding funds or resetting state. Changed identity content conflicts. IDs are never recycled, even after cancellation or settlement.
- A repeated `start` returns `already_started`, including after settlement. If its first acknowledgement was lost, the host must reconcile; a retry is not a fresh dispatch permit.
- Exact settlement repeats are harmless; contradictory known costs conflict. Later unknown evidence cannot erase known spending.

Snapshots are detached and immutable. They contain financial identity, counters and reservation status, not prompts, execution outputs, credentials or receipts. Events contain bounded metadata and storage-assigned timestamps. Continue event reads from the last returned sequence; each page contains at most 1,000 events. No-op retries add neither events nor versions.

## Limits and persistence

This development profile allows 128 lifetime accounts, depth 16, 128 lifetime bundles, 512 lifetime reservations, 1 MiB snapshots and 2,048 lifetime events per root. Limits preserve room for closure and the full unknown/known evidence suffix. They are correctness-first bounds, not a high-throughput or unlimited retention claim.

Both adapters share one reducer and use short root-first transactions. One root's admission, accounting and event changes commit together. PostgreSQL can operate on independent roots concurrently; SQLite retains its single-writer behavior. There are no external callbacks inside a transaction. A trusted internal same-session seam supports later execution integration without copying a ledger engine.

Stored state and counter projections are checked, and event count/sequence/head integrity is checked during ordinary operations. Requested event pages additionally validate their exact metadata. This is not a full historical semantic replay on every command or a tamper-proof audit against a privileged database administrator.

Close the application-owned store when its work is finished. Closing the store is different from `closeSubtree`: it closes the connection/worker but does not close persisted financial accounts. Reopen storage and initialize the capability before continuing.

See the [exact contract and recovery acceptance](../specs/durable-budget-ledger.md), [storage installation guide](storage-installation.md) and [development ledger](../development-status.md). Durable child execution, grants, cancellation trees, provider fencing and production qualification remain separate work.
