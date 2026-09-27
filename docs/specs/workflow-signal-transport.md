# Authenticated durable workflow signals

Status: implemented experimental signal-delivery transport. Unit, Fetch-facade, real loopback-host and isolated browser/archive checks pass. The application adapter owns durable command journaling, workflow-format selection and WorkStream delivery.

## Command

`POST /v1/workflow-runs/:runId/signals` accepts exactly `{ commandId, revision, signalId, signalName, value }`.

The route requires `workflows:control`, a verified unexpired identity, an exact 64-hex run ID, a positive safe expected revision and bounded stable command/signal identifiers. `value` must be plain JSON whose canonical encoding is at most 4 KiB, with at most 16 levels and 1,024 nodes. The trusted adapter receives an immutable value plus verified scope, authorized agent IDs and actor identity; bearer credentials do not cross that boundary.

## Durable adapter contract

`AgentServerOptions.workflowSignals.deliver` is separate from cancellation and approval so adding signal delivery does not silently expand an existing adapter's authority. It returns the same exact `applied`, `conflict` or `not_found` result used by workflow controls. An applied acknowledgement contains only a revalidated content-free workflow view for the requested run, with a revision not older than the precondition.

The adapter must atomically verify the expected revision, authorize the target signal for the selected workflow definition, persist the signal and journal `commandId` with authenticated scope, action and canonical request digest. An identical committed replay returns the stored result; changed reuse conflicts. When backed by `mayura/workstream`, forward `signalId`, `signalName` and `value` unchanged so its identical-signal idempotency remains authoritative. A signal is broadcast data, not an arbitrary workflow-step transition or permission grant.

Mayura makes one adapter call and clients make one request. HTTP 409 means a known conflict. A transport timeout is ambiguous: it does not prove that the signal was not committed. Reconcile with the same command ID; never generate a new ID and retry automatically.

Callbacks share the bounded workflow-operation pool. Timed-out non-cooperative callbacks retain admission until settlement. Adapter exceptions become `WORKFLOW_UNAVAILABLE`; malformed acknowledgements become `WORKFLOW_TRANSPORT_INVALID`; unauthorized and absent records are not distinguished.

## Limits

This boundary does not discover signal names, validate an application-specific signal schema, resume arbitrary nodes, retry failed steps, dispatch tools, change definitions or make an adapter durable. Existing workflow runtimes and stores remain authoritative for state transitions, wait matching, cancellation races, effects, budgets and retention.
