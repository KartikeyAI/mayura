# Bounded worker draining

Status: **implemented for every effect-dispatching workflow runtime, fleet wrapper, coordinator and host**. It is a local shutdown discipline, not distributed leader handoff.

`close()` remains an immediate stop: it aborts in-flight effects and leaves their outcome to receipts and recovery. `drain({ timeoutMs })` is the graceful alternative for deployments, rolling restarts and incident response:

1. Admission stops at once. New `runUntilSettled` calls reject with `CANCELLED`; a drive already in progress ends at its next wave boundary without starting that wave.
2. Every wave that was already admitted — including its claims, dispatched external effects, receipt persistence and completion transitions — is allowed to finish, up to the deadline (default 30 s, maximum 300 s).
3. The worker then closes exactly once and resolves `{ drained, interrupted }`. `drained` is true only when every admitted wave settled in time; `interrupted` counts waves that were still running and were aborted by the close.

Admission is counted per drive wave rather than per effect because every format already awaits its effects and their durable receipts inside the wave. A dependent step whose predecessor finished during the drain is therefore never dispatched: it stays `pending` for the next worker. Repeated `drain` calls return the same report. Draining never closes application-owned storage, and it never changes durable run state beyond what the admitted waves themselves commit.

| Component | Behavior |
|---|---|
| `createWorkflowRuntime` (format 2), lifecycle runtime (format 5) | Wave admission around node execution. |
| Scheduled driver: `createScheduledWorkflowRuntime`, `createWorkflowGraphRuntime` (format 3) | Wave admission covers recovery, preparation, claims and claimed effects; no new claim is taken while draining. |
| `createWorkflowTreeRuntime` (format 4) | Wave admission covers root/child preparation, admission and effects. |
| Lifecycle fleet, saga, loop and composite fleet runtimes | Delegate to the owned lifecycle runtimes; composite fleets drain sagas and loops in parallel and sum `interrupted`. |
| Graph and tree coordinators | Drain the owned driver, then close discovery. |
| Lifecycle and composite hosts | Abort the loop's delay so no further cycle starts, drain the owned runtime, then wait for the active cycle to finish. |

An interrupted wave has the same durable outcome as a process crash at that point: a started effect is later resolved by the format's recovery path (`recoverAbandoned`, expired-lease recovery or external reconciliation), never replayed. Deployments that need zero interruption should size `timeoutMs` above the longest tool timeout they admit.
