# Durable operator pause foundation

Status: **experimental format-2 foundation; broader operational control remains incomplete**.

The conservative format-2 runtime exposes explicit `pause(runId)` and `resume(runId)` operations. A pause is an atomic durable transition from `running` or `waiting` to `paused`. It is admitted only while every tool effect is quiescent: no step may be `dispatching`. If dispatch preparation races the command, aggregate compare-and-set permits exactly one transition to win; the loser reloads authoritative state. A started or uncertain effect must settle or be reconciled before pause can succeed.

`runUntilSettled` performs no scheduling while paused, including after storage close/reopen. Human approval may be recorded during a pause, but does not resume scheduling. Resume only changes the run-level scheduling state: any unresolved step wait restores `waiting`; otherwise it restores `running`. It never resolves approval, grants permission, changes the pinned definition/policy, replays an effect or creates a replacement run.

Repeated pause of an already paused run is idempotent. Pausing a terminal run, resuming a non-paused run and pausing a run with an in-flight effect conflict. Cancellation remains available while paused and is terminal. Events contain metadata-only `run.paused` and `run.resumed` facts.

The content-free server, browser and CLI workflow-view validators recognize `paused`, so application adapters can display the authoritative state without payload disclosure. This slice does not yet provide an authenticated pause command, format-3/4/5 storage transitions, fleet-wide pause, worker draining or public-ingress qualification; those must be completed before the general operator-pause roadmap item can close.
