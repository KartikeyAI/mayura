# @mayurajs/authz-oso

Native Oso Cloud single-check authorization through Mayura's core policy, enforcement and audit contract. Uses
web-standard Fetch and depends only on the `mayura` peer. Explicit endpoint/environment credentials, exact mappings,
full-scope typed IDs, bounded deadlines/bytes/concurrency and no automatic retries or allow cache.

See [the integration guide](../../docs/integrations/authz-oso.md) for installation, configuration, fact provisioning,
revision/consistency limits, lifecycle, server wiring and OpenTelemetry audit reuse.

This slice targets Oso Cloud centralized HTTP checks, not the embedded Oso library or local SQL authorization.
There are no context facts, policy/fact writes, automatic synchronization or ambient credential lookups. The host
owns deployed policy/data and supplies the environment identity/revision assertions; the native boolean result does
not attest them. Configure readiness outside the adapter.

## Primary references

Reviewed 2026-10-20. No SDK or live-service authorization requests were performed.

- [Official native authorization API, request and response](https://www.osohq.com/docs/api-reference/check-api/post-authorize)
- [Authorization enforcement patterns](https://www.osohq.com/docs/develop/enforce/authorize-requests)
- [Fact provisioning](https://www.osohq.com/docs/develop/facts/overview)
- [Service SDK authorization checks](https://www.osohq.com/docs/reference/sdks/authorization-checks)

Offline regression tests are authored. Tests and all validation remain deferred.
