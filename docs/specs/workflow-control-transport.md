# Authenticated durable workflow controls

Status: implemented experimental cancellation and approval transport. Unit, Fetch-facade, real loopback-host and isolated browser/archive checks pass. The application adapter still owns durable command journaling and runtime selection.

## Commands

`POST /v1/workflow-runs/:runId/cancel` accepts exactly `{ commandId, revision }`.

`POST /v1/workflow-runs/:runId/approvals` accepts exactly `{ commandId, revision, nodeId, approvalDigest, childRunId }`. `childRunId` is either an exact 64-hex required-child identity or `null` for a root node.

Both routes require `workflows:control`, a verified unexpired identity, an exact 64-hex run ID, a positive safe revision and a bounded stable command ID. The trusted adapter receives verified scope, authorized agent IDs and actor ID; bearer credentials and request bodies do not cross that boundary. Approval is pinned to one node, review digest, revision and optional child. Cancellation carries no claim that a dispatched external effect stopped.

## Adapter result and idempotency

The adapter returns one exact result:

- `applied` with a content-free workflow view whose run identity matches and revision is not older than the command precondition;
- `conflict`, mapped to HTTP 409 `WORKFLOW_CONFLICT`; or
- `not_found`, mapped to HTTP 404 without disclosing whether the record is absent or unauthorized.

The adapter must durably journal `commandId` with the authenticated scope, action and canonical command digest in the same transaction as the mutation. Repeating an identical committed command returns its stored `applied` result; reusing the ID with different inputs returns `conflict`. Mayura's HTTP facade and browser client perform exactly one callback/request and never retry an ambiguous acknowledgement.

Callbacks share the bounded workflow-operation pool with reads. A timed-out or cancelled non-cooperative callback retains its slot until settlement. Exceptions are sanitized as `WORKFLOW_UNAVAILABLE`; malformed, hostile, cross-run or stale acknowledgements become `WORKFLOW_TRANSPORT_INVALID`. Capability and request cancellation are rechecked before release.

## Browser command state

`createWorkflowCommandController` is an inert, caller-owned external store bound to one validated workflow view and revision. It starts exactly one cancellation, approval, signal delivery or continuation request only when the application invokes that method, publishes immutable pending/success/conflict/failure state and never retries. Approval intent must identify one waiting projected node; a required-child identity must exactly match the admitted view. Signal intent is copied into at most 4 KiB of immutable JSON, passed to the client once and never retained in controller state. Resume is available only when the client implements the separate continuation adapter and does not convert waiting state locally. A successful response must retain run and definition identity and cannot move revision backwards.

The controller owns a local abort signal, bounds subscribers and sanitizes unknown callback errors. Disposal aborts local waiting but does not claim that the durable command did not commit. Resetting presentation state does not advance the bound workflow revision: applications must construct a new controller from a newly authenticated view before authorizing a subsequent state-dependent command. The optional React hook only subscribes to this state and starts no I/O.

## Limits

This boundary does not expose arbitrary step transitions, tool dispatch, retry, force-resume, signal discovery/schema negotiation, definition changes, output injection or credential forwarding. Signal and continuation transports are separately configured least-authority adapters and are unavailable from the controller unless the supplied client implements them. The controller does not itself make a storage adapter durable. Existing format-specific runtimes and stores remain authoritative for approval/signal consumption, continuation, cancellation races, effect receipts, budget settlement and required-child ownership.
