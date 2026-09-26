# Workers and leadership

Status: **implemented for v1**. See also [worker draining](worker-draining.md) and the [production server](production-server.md).

## Leadership lease

`createWorkflowLeadership({ store, scope, role, holderId, leaseMs })` keeps one durable lease per scope and duty (`role`) in any aggregate store. `acquire()` is a single compare-and-set step that creates, renews, observes or takes over the lease. Renewal keeps the fence; every change of holder, including taking over a lapsed lease, increments it. `release()` ends a held lease immediately so a standby does not wait for expiry.

The holder treats itself as leader only until a third of the lease remains (`isLeader()`), while other replicas take over only after expiry. Replicas' clocks must therefore agree to within a third of the lease (default 15 s; 3 s–10 min).

The lease prevents duplicated host work; it is not the correctness mechanism. Every format runtime stays safe under concurrent drivers through its own compare-and-set, claims and fences, so a brief overlap during clock skew or a partition wastes work but cannot duplicate an admitted effect.

## Worker supervisor

`createWorkflowWorker({ units, leadership, renewIntervalMs })` supervises up to 32 units — lifecycle and composite hosts directly, and graph or tree coordinators through `coordinatorUnit(coordinator, { intervalMs, limit })`, which pages continuously while running and pauses between complete sweeps.

- Every `renewIntervalMs` (default 4 s; keep it under a third of the lease) the worker renews or contests the lease. Units start when this replica becomes leader and stop as soon as it is not.
- If the lease cannot be confirmed, the worker stops its units rather than risk two active leaders, and reports the error code.
- `isReady()` is true while the worker runs, is not draining and confirmed the lease within three intervals. It is suitable for a readiness probe.
- `drain({ timeoutMs })` stops renewing, drains every unit within one deadline, then releases the lease so a standby takes over at once. It resolves with the combined `{ drained, interrupted }` report.

Without `leadership`, units start immediately: a single-replica deployment.

A scope can be driven by different replicas for different duties by giving each duty its own role. Distributed deployments still need every replica to use the same storage and scope, and a fleet hold (see [fleet pause](fleet-pause.md)) applies to every host regardless of which replica leads.
