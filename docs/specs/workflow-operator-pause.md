# Durable operator pause foundation

Status: **experimental format-2, format-3 and format-5 foundation; broader operational control remains incomplete**.

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

## Remaining work

The content-free server, browser and CLI workflow-view validators recognize `paused`, so application adapters can display the authoritative state without payload disclosure. This slice does not yet provide an authenticated pause command, format-4 storage transitions, fleet-wide pause, worker draining or public-ingress qualification; those must be completed before the general operator-pause roadmap item can close.
