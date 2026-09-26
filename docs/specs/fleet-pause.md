# Fleet-wide pause

Status: **implemented experimental durable hold and ledger-backed sweep for one scope**. It composes the per-run [operator pause](workflow-operator-pause.md) and [worker draining](worker-draining.md); it adds no new per-run state.

```ts
import { createWorkflowFleetControl, graphFleetTarget, lifecycleFleetTarget, treeFleetTarget,
  type WorkflowFleetSweepCursor } from '@mayura/workflows';

const fleet = createWorkflowFleetControl({ store, scope });
const targets = [lifecycleFleetTarget(lifecycleFleet), graphFleetTarget(graphDiscovery, graphRuntime), treeFleetTarget(treeDiscovery, treeRuntime)];

await fleet.hold(); // 1. hosts and coordinators configured with `hold: fleet` stop driving runs
let cursor: WorkflowFleetSweepCursor | null = null;
do { cursor = (await fleet.sweepPause(targets, { cursor })).nextCursor; } while (cursor); // 2. pause every discoverable run
// ...incident handling...
await fleet.release(); // 3. lift the hold
do { cursor = (await fleet.sweepResume(targets, { cursor })).nextCursor; } while (cursor); // 4. resume only what the fleet paused
```

## Durable hold

`createWorkflowFleetControl({ store, scope })` keeps one aggregate record per scope under its own hash domain. `hold()` and `release()` are idempotent compare-and-set transitions; `generation` increments on each hold. The hold survives restart and is shared by every process using the same store and scope.

Lifecycle and composite hosts and graph and tree coordinators accept an optional `hold` (any `{ isHeld(): Promise<boolean> }`, including the fleet control itself). They consult it before every cycle or page and fail closed: if the hold state cannot be confirmed, the cycle fails instead of driving runs. A held host cycle reports `held: true` with no pages. A held coordinator page is reported as `interrupted` with code `CANCELLED`, `examined: 0` and the unchanged `retryCursor`, so existing exhaustive report handling keeps compiling. Workers that call `runUntilSettled` directly are not stopped by the hold; the sweep is what fences them.

## Sweep and ledger

`sweepPause(targets, { cursor, limit })` requires the hold and processes one discovery page of one target per call. A target adapts one format's discovery plus its runtime's `inspect`/`pause`/`resume`: `lifecycleFleetTarget` (format 5 fleet index), `graphFleetTarget` (format 3) and `treeFleetTarget` (format 4, tree-wide). Each discovered run is inspected; terminal and already-paused runs are left alone. Otherwise the sweep records a `pending` ledger entry, pauses the run through the ordinary per-run pause, then marks the entry `confirmed`.

- A run whose effect is claimed or in flight conflicts: its entry is removed and it is reported `busy`. Drain or wait, then sweep again.
- An unknown failure after the pending entry is written leaves the entry in place, because the pause may have committed; resume settles it.
- Runs an operator had paused individually are reported `already_paused` and never enter the ledger.

`sweepResume` requires the hold to be released and walks the 256 ledger shards with a cursor that also records the position inside a shard. For each entry it resumes the run if it is still paused (`resumed`), otherwise reports `not_paused`, then removes the entry. Entries whose target is not supplied are retained and reported `unregistered`; a missing run is dropped. Each shard holds at most 256 entries.

## Authenticated transport

A separately configured `workflowFleet` server adapter exposes `GET /v1/workflow-fleet` (`workflows:read`) and `POST .../hold`, `.../release`, `.../sweeps/pause` and `.../sweeps/resume` (the dedicated `workflows:fleet` capability, which `workflows:control` does not imply). The server passes only verified scope, agent IDs and actor identity, admits bounded commands (`limit` 1–128, opaque object cursor ≤ 4 KiB), shares bounded workflow-operation admission and revalidates every reply: hold and release acknowledgements must show the requested state, and sweep pages must be content-free and no longer than the limit. The browser client adds `workflowFleet`, `holdWorkflowFleet`, `releaseWorkflowFleet` and `sweepWorkflowFleet`; the CLI adds `fleet-get`, `fleet-hold`, `fleet-release` and a bounded multi-page `fleet-sweep` that can continue from a cursor file. See the [fleet control guide](../how-to/fleet-control.md).

## Limits

The ledger cannot distinguish a fleet pause from an individual pause applied to the same run after the fleet paused it; fleet resume will lift both. The format-2 conservative runtime and saga/loop parents have no discovery surface and are not swept. Sweeps are not atomic across a scope; runs submitted while held are paused by the next sweep, and in the meantime hosts and coordinators configured with the hold do not drive them.
