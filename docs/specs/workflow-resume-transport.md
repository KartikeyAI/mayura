# Authenticated durable workflow continuation

Status: implemented experimental continuation-request transport. The application adapter remains authoritative for pinned definitions, current authorization, reconciliation and durable command journaling.

## Command

`POST /v1/workflow-runs/:runId/resume` accepts exactly `{ commandId, revision }` and requires `workflows:control`. The server derives scope, authorized agent IDs and actor identity from verified authentication, accepts only an exact 64-hex run identity and positive safe expected revision, and invokes one separately configured `AgentServerOptions.workflowResumes.resume` callback.

This is a request to schedule or perform normal continuation from already durable state. It is not authority to mark a wait satisfied, approve a node, invent a signal, replay uncertain effects, switch definition versions or reopen terminal history. An adapter must return `conflict` when the expected revision is stale, the run cannot safely continue, a required gate remains unresolved, or command identity is reused with different content.

## Idempotency and result

The adapter atomically journals `commandId` with authenticated scope, action and canonical request digest before acknowledging a durable continuation decision. Identical committed replay returns the stored result; changed reuse conflicts. It returns the shared exact `applied`, `conflict` or `not_found` workflow result. Applied views are revalidated as content-free, run-bound format 2–5 state and cannot move revision backwards. A successful response may retain the same revision and waiting status when continuation correctly observes an unresolved gate.

Mayura performs one callback/request and never retries an ambiguous acknowledgement. HTTP 409 is a known conflict; timeout or connection loss is unknown and must be reconciled with the same command ID. Callback work shares bounded workflow-operation admission and retains its slot until actual settlement.

## Limits

The framework transport cannot prove that an arbitrary application callback uses the pinned definition or correctly reconciles effects. Applications should route the request to the format-specific registered coordinator/host and preserve its normal authorization, lease, receipt and recovery rules. For a run in the operator `paused` state, the adapter calls the format runtime's scheduling-only `resume(runId)` before continuing; entering the pause uses the separate [pause command](workflow-operator-pause.md#authenticated-pause-command). This boundary does not implement terminal continuation runs, bulk fleet control or an always-on durable host.
