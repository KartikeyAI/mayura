# ADR 0010: Durable Code Mode phases reuse scheduled workflow authority

Status: accepted for an experimental durable-composition profile.

## Context

An ephemeral JavaScript isolate cannot be serialized safely across restarts. Re-running an entire generated program after a worker or host failure can repeat writes whose results were not returned. Mayura already has a selected-storage scheduled-workflow profile with exact candidate approvals, leases, execution receipts, conservative unknown outcomes and no automatic replay of started writes. Creating a second phase ledger would duplicate those authority and recovery rules.

## Decision

Ship optional `@mayura/code-mode-workflows`. `defineDurableCodeWorkflow` converts 1–128 explicit Code Program definitions into ordinary genuine workflow tool nodes. Every phase:

- stores only bounded JSON input/output and ordinary workflow evidence;
- pins its tool version to the complete content-addressed program digest;
- requires human approval, with the existing candidate digest binding program, input, policy and expiry;
- executes through a genuine captured Code Mode runtime and its sandbox/broker boundary;
- persists one immutable scope-bound nested-receipt audit aggregate before the outer phase settles;
- inherits the strongest effect declared by its nested tool catalog; and
- reserves a conservative bound equal to `maxToolCalls × highest declared nested-tool cost`, then atomically settles verified known usage and retains only unresolved usage with the outer receipt.

The selected `createScheduledWorkflowRuntime` and storage adapter provide persistence, fencing, approval records and recovery. A started write/host phase that does not produce a confirmed result becomes `outcome_unknown`; continuation never silently invokes that phase again. Completed phases reuse their stored output. A later phase receives only validated serialized bindings, never a JavaScript heap, closure or pending promise.

## Evidence and consequences

SQLite exercises approval-before-execution, close/reopen, exact digest rejection, verified human identity, brokered nested writes, exact usage settlement, immutable nested audit inspection and one execution after completion. PostgreSQL independently retains the approval, settlement and audit across close/reopen and executes once. A failure injected after a nested write records its successful nested receipt, atomically charges that known cost despite a withheld unknown outer receipt, and repeated continuation performs neither the sandbox nor nested write again. Real-process matrices on both SQLite and PostgreSQL terminate the worker after the nested effect, after the outer success receipt commits and after step completion commits. Effect recovery has no fabricated audit and retains the full maximum; receipt/completion recovery retains the already committed nested audit and exact settlement. Effect/receipt recovery preserves an unknown terminal result and performs zero replays; completion recovery finalizes the stored output and also performs zero replays. Forged program/mode/audit handles and accessor-bearing definitions fail before workflow creation. Extended receipt fields are discarded at the Code Mode boundary. An isolated packed consumer compiles and constructs the definition with no SQL driver.

Admission remains conservatively bounded, while committed outer receipts settle exact verified usage. The audit sidecar and scheduled workflow receipt are distinct durable commits; absence therefore means unavailable evidence, not proof that no effect occurred. The application must re-register the exact genuine workflow/program/mode/audit catalog after restart. Cross-adapter process recovery is qualified only for the three explicit boundaries above; arbitrary host loss, authoritative external-effect reconciliation and production sandbox containment remain separate requirements before closing V15. See the [durable phase specification](../specs/code-mode-durable-phases.md).
