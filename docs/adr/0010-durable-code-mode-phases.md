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
- inherits the strongest effect declared by its nested tool catalog; and
- reserves a conservative fixed cost equal to `maxToolCalls × highest declared nested-tool cost`.

The selected `createScheduledWorkflowRuntime` and storage adapter provide persistence, fencing, approval records and recovery. A started write/host phase that does not produce a confirmed result becomes `outcome_unknown`; continuation never silently invokes that phase again. Completed phases reuse their stored output. A later phase receives only validated serialized bindings, never a JavaScript heap, closure or pending promise.

## Evidence and consequences

SQLite exercises approval-before-execution, close/reopen, exact digest rejection, verified human identity, brokered nested writes, conservative accounting and one execution after completion. PostgreSQL independently retains the approval across close/reopen and executes once. A failure injected after a nested write produces a withheld unknown receipt and repeated continuation performs neither the sandbox nor nested write again. A separate fixture kills the actual SQLite worker process after the nested write and before the phase returns; expiry recovery preserves an unknown terminal result and performs zero replays. Forged program/mode handles and accessor-bearing definitions fail before workflow creation. An isolated packed consumer compiles and constructs the definition with no SQL driver.

The fixed maximum phase charge is intentionally conservative and can exceed actual nested use. Nested receipts are not yet a separate durable audit stream. The application must re-register the exact genuine workflow/program/mode catalog after restart. The dedicated process test covers one SQLite post-write boundary; the complete phase/receipt/completion matrix on both adapters remains required before closing V15. See the [durable phase specification](../specs/code-mode-durable-phases.md).
