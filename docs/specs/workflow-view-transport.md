# Authenticated durable workflow view transport

Status: implemented experimental read-only transport. Unit, Fetch-facade, real loopback-host and isolated browser/archive checks pass. Explicit cancellation/approval transport is specified separately; a production durable host remains separate work.

## Server contract

`AgentServerOptions.workflowViews` accepts one trusted application callback, `inspect`. `GET /v1/workflow-runs/:runId` requires a verified identity with `workflows:read`; the callback receives only the verified scope, authorized agent IDs, exact 64-hex run ID and request cancellation signal. Missing transport or records return `NOT_FOUND`. Callback failures become `WORKFLOW_UNAVAILABLE` and never disclose exception text.

The server admits at most `maxWorkflowOperations` concurrent callback executions and retains the slot until a non-cooperative callback actually settles. It rechecks cancellation and capability expiry after the callback. Returned data must be an exact content-free format 2–5 view: bounded nodes/edges, admitted kinds/statuses, matching step identities, known dependencies, acyclic topology and format-correct child links. Unexpected content, cross-run identity, accessors, cycles or malformed values fail with `WORKFLOW_TRANSPORT_INVALID`.

The callback is responsible for loading a matched authoritative definition and snapshot, applying tenant/project/agent authorization before returning, and preventing time-of-check/time-of-use mixups. The facade does not acquire a SQL driver, discover definitions, infer authorization or mutate workflow state.

## Client contract

`MayuraClient.workflow(runId)` performs one authenticated GET with the client's existing explicit token, timeout, response-size, origin, redirect and cookie-denial rules. It accepts only the exact frozen workflow envelope and returns `WorkflowViewInput`. It performs no retry, polling, subscription or command.

Pass the result to `createWorkflowGraphProjection` or `useMayuraWorkflowGraph` for full DAG/format validation and presentation metadata. A view is a point-in-time projection identified by its revision; it is not a lease, approval, readiness authorization or execution command.

## Exclusions

This slice does not expose prompts, tool inputs/outputs, human response values, credentials, budgets, artifacts or private events. It does not implement list/discovery, child expansion, cancellation, approval, retry, resume, signal delivery, durable subscriptions or mutation idempotency.
