# External Effect Reconciliation

Status: normative runtime contract.

Mayura may lose local execution authority after a durable tool effect has started. A workflow then remains `outcome_unknown`: it is never replayed merely because its worker disappeared. External effect reconciliation lets an application resolve the retained cost uncertainty using a trusted, provider-specific verifier without pretending that Mayura can infer the provider's state.

## Trust boundary

- Reconciliation is disabled unless the runtime is configured with `verifyExecution`.
- The callback receives an immutable, bounded description of one persisted attempt plus an opaque caller credential. Raw credentials and provider responses are never persisted.
- The callback must authenticate its authority and return a bounded data-only attestation containing a stable authority ID, a stable attestation ID, a known execution result, and verified cost.
- Callback failure, timeout, malformed data, scope mismatch, definition mismatch, and cost above the admitted tool maximum fail closed.

`defineExternalEffectVerifier` declares one exact tool ID/version route and fixes its authority ID outside provider-returned data. `composeExternalEffectVerifiers` accepts only genuine definitions from the same package instance, rejects duplicate routes, snapshots and validates the runtime request before credential dispatch, and validates the provider's exact three-field attestation. The resulting callback can be supplied directly as `verifyExecution`. This is a composition foundation, not a provider API client.

## State transition

- Only the exact persisted tool node and a started scheduler attempt in `outcome_unknown` may be reconciled.
- The attestation becomes a withheld known receipt and an exact settlement in one atomic storage command.
- The evidence identity binds the attempt, authority, attestation, receipt, and settlement. Repeating the same attestation is idempotent. Contradictory known evidence is retained as conflicting evidence and cannot replace the first accepted known fact.
- Reconciliation may settle reserved cost, but it never publishes tool output, resumes downstream nodes, releases quarantined resources, or replays the effect. The workflow remains terminal in its existing state.
- `not_started` requires zero verified cost. `succeeded` and `failed` may report any non-negative verified cost up to the tool's admitted maximum.

## Non-goals

This boundary does not claim universal exactly-once execution, infer an external provider's state, or define provider credentials. Concrete provider adapters must still implement authoritative verification for their own idempotency and audit models; no live provider is qualified by the router tests.
