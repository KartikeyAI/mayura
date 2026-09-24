# Workflow lifecycle format 5

Status: authoring, strict state codec and conservative durable runtime implemented over the public aggregate-store contract.

Format 5 is a new, explicit persistence boundary for workflows that suspend on a human response or an absolute timer. It does not reinterpret formats 2, 3, or 4, and no existing persisted workflow is migrated implicitly.

## Authoring contract

`defineWorkflowLifecycle` accepts the existing `tool` and `join` nodes plus:

- `human`: a typed information, correction, or plan-selection request. The persisted manifest contains a schema ID and SHA-256 schema digest, but never a validator callback. Correction requests require a bound subject digest; other request kinds prohibit one.
- `timer`: an absolute `fireAtMs` binding. Relative durations and executable time expressions are prohibited because replay must resolve the same persisted deadline.

All bindings are data-only literals, submission-input paths, or paths into declared dependency outputs. A step binding that is not also a declared dependency is rejected. Graphs are finite, acyclic, and limited to 128 nodes, including at most 32 human nodes and 64 timer nodes.

Definitions are branded executable objects local to the installed package instance. Manifests are detached, deeply immutable JSON values and use the digest domain `mayura:workflow-lifecycle:v1`.

## Compatibility

- Format 2 remains the scheduled tool/join contract.
- Format 3 remains the existing-execution wait graph contract.
- Format 4 remains the required-child workflow tree contract.
- Format 5 decoders reject all other format numbers, and older decoders reject format 5.

The response Standard Schema is intentionally executable-only. A future durable runtime must resolve a registered definition whose schema ID and digest exactly match persisted authority before accepting a response.

## Runtime contract

The runtime persists human request digests, typed response evidence, absolute timer deadlines and fire evidence in the workflow aggregate. Exact repeated responses are idempotent; different responses conflict. Deadlines and timers resume after reopening SQLite, PostgreSQL or a conforming custom adapter. `nextWakeAtMs` lets the host schedule finite continuation without retaining callbacks or timer handles.

Tool dispatch uses the conservative effect protocol: authority and budget are persisted before invocation, receipts are monotonic, and abandoned dispatches require explicit reconciliation. Human identity is supplied only through a bounded trusted verifier and is checked against the configured project.

`humanRequest` reconstructs display metadata from the pinned definition and persisted bindings, then verifies the request digest before disclosure. The lifecycle human-transport controller maps explicitly registered runs to opaque stable request IDs and structurally implements the authenticated server transport without coupling the workflow package to the server package. Validator and identity callbacks have finite timeouts and retained-callback admission: a callback that ignores timeout continues to consume capacity until it actually settles.

The runtime intentionally does not scan all aggregates or start a background worker. The current server/browser/CLI path requires explicit in-memory run registration; durable fleet discovery, automated wake dispatch, loops and compensation remain separate follow-on capabilities.
