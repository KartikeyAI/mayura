# Durable operator pause foundation

Status: **experimental foundation for formats 2–5; broader operational control remains incomplete**.

The conservative format-2 runtime exposes explicit `pause(runId)` and `resume(runId)` operations. A pause is an atomic durable transition from `running` or `waiting` to `paused`. It is admitted only while every tool effect is quiescent: no step may be `dispatching`. If dispatch preparation races the command, aggregate compare-and-set permits exactly one transition to win; the loser reloads authoritative state. A started or uncertain effect must settle or be reconciled before pause can succeed.

`runUntilSettled` performs no scheduling while paused, including after storage close/reopen. Human approval may be recorded during a pause, but does not resume scheduling. Resume only changes the run-level scheduling state: any unresolved step wait restores `waiting`; otherwise it restores `running`. It never resolves approval, grants permission, changes the pinned definition/policy, replays an effect or creates a replacement run.

Repeated pause of an already paused run is idempotent. Pausing a terminal run, resuming a non-paused run and pausing a run with an in-flight effect conflict. Cancellation remains available while paused and is terminal. Events contain metadata-only `run.paused` and `run.resumed` facts.

A pause that commits while `runUntilSettled` is between waves ends that call without completing the run, even if every step has already reached a terminal status; completion is recorded after resume.

## Format 5 lifecycle runs

The format-5 lifecycle runtime exposes the same `pause(runId)`/`resume(runId)` contract, with metadata-only `lifecycle.run.paused` and `lifecycle.run.resumed` events. Every scheduling transition — human request, human deadline timeout, timer scheduling and firing, approval expiry and dependency skip — re-reads the authoritative run inside its compare-and-set retry and does nothing while the run is paused or cancelled, so a pause committed after a worker's initial read cannot be overwritten back to `running` or `waiting`. Tool dispatch additionally requires `running` at the pre-dispatch check.

While paused, a waiting human request may still accept its exact digest-bound response and a tool approval may still be recorded; both leave the run `paused`. Timer deadlines that elapse during the pause do not fire until the run is resumed; the timer then fires with the actual observation time. Resume restores `waiting` when a human, timer or approval wait remains, otherwise `running`.

The lifecycle fleet index records `paused` as a nonterminal status. `runPage` reports a paused candidate as `deferred` without loading or advancing it, and a fleet-wrapped `pause`/`resume` updates the index atomically with the run's observed version. Resumed runs are advanced by the next scan.

## Format 3 graph runs

Format-3 graph pause is an atomic SQL transition inside the scheduled writer, not a runtime-side flag. `WorkflowGraphStore` gains optional `pause`/`resume` commands; both SQL adapters implement them, and custom graph adapters that omit them keep working until a caller requests pause, which then fails with `UNSUPPORTED_PROFILE`. The scheduled-v1 facade does not admit either command.

Quiescence is stricter than in the aggregate-only formats because the scheduler separates claiming from starting: pause conflicts while any owned job is `leased` or `started`. A never-started lease must be completed, abandoned or recovered after expiry before pause is admitted. Because pause and claim both lock the run, exactly one wins. While paused, `claim` returns no work, `advance` changes nothing (wait targets are not resolved and dependents are not skipped), and `prepare`, `requestApproval`, `failNode`, `start` and `finalize` conflict. An already-requested approval may still be recorded without leaving the paused state, and cancellation remains terminal. Resume sets `running` and re-derives the run status through the ordinary advance reducer, so a wait whose targets finished during the pause resolves on resume and unresolved waits or reviews restore `waiting`. Events contain `run.paused` and `run.resumed`.

The graph driver treats `paused` as a halt, like a terminal state, and `createWorkflowGraphRuntime` exposes `pause(runId)`/`resume(runId)`. Graph discovery continues to return only `running` and `waiting` runs, so a coordinator does not load paused graphs; a graph paused between discovery and continuation is reported as an observed `paused` outcome.

## Format 4 workflow trees

A format-4 pause is tree-wide and recorded on the root. `WorkflowTreeStore` gains optional `pauseRoot`/`resumeRoot` commands, implemented by both SQL adapters. Pause locks the root's job links and conflicts while any root **or child** job is `leased` or `started`; claim and pause serialize on the root lock. While the root is paused, root and child claims return no work, and root/child start, child approval requests, child preparation, child finalization, child join and root finalization conflict; new child admission and root preparation were already limited to a `running`/`waiting` root. Root and child approvals may still be recorded, and a root approval no longer resets a paused root to `running`. Cancellation remains available and now cancels a paused tree rather than preserving the pause as an outcome.

Child aggregates keep their own status; the pause lives only on the root. Resume restores `waiting` when a root step is waiting (an approval or an admitted child), otherwise `running`. Expiry recovery is not suppressed: an approval that expires on a prepared-but-unclaimed job may still settle the affected member as `blocked` during a pause, because that is an observation of elapsed authority rather than new scheduling.

The tree runtime halts on a paused root before its terminal-cleanup path, reports a pause committed mid-drive as a `paused` snapshot rather than a storage conflict, and exposes `pause(runId)`/`resume(runId)`. Custom tree adapters that omit the optional commands keep working; pause then fails with `UNSUPPORTED_PROFILE`. Tree discovery continues to return only `running` and `waiting` roots.

## Authenticated pause command

`POST /v1/workflow-runs/:runId/pause` accepts exactly `{ commandId, revision }`, requires `workflows:control` and invokes one separately configured `AgentServerOptions.workflowPauses.pause` callback with verified scope, authorized agent IDs and actor identity. It shares the continuation route's validation, bounded operation admission and acknowledgement checks: `applied` views are revalidated as content-free, run-bound and not older than the command revision; `conflict` maps to HTTP 409; `not_found` maps to 404; exceptions become `WORKFLOW_UNAVAILABLE`. The adapter journals `commandId` exactly as for the other workflow commands. Mayura sends one request and never retries an ambiguous acknowledgement.

Lifting a pause uses the existing continuation command: a continuation adapter that observes a paused run calls the format runtime's `resume(runId)` and then continues normally, still without authority to satisfy a gate. The browser client exposes `pauseWorkflow`; the command controller adds a `pause` action available only from a `running` or `waiting` view, and its `resume` action is available from a `paused` view. The CLI adds `workflow-pause`. See the [pause guide](../how-to/workflow-pause.md).

## Remaining work

The content-free server, browser and CLI workflow-view validators recognize `paused`, so application adapters can display the authoritative state without payload disclosure. All four durable formats now have a storage-level pause and an authenticated pause command; [fleet-wide pause](fleet-pause.md) and [worker draining](worker-draining.md) build on it. Still missing are an authenticated fleet-control transport, worker draining or public-ingress qualification; live UI qualification of the pause controls; those must be completed before the general operator-pause roadmap item can close.
