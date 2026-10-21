# @mayurajs/authz-permit

Native Permit.io PDP `/allowed` checks through Mayura's core authorization and audit contract. Explicit host
credentials, exact action mappings, scoped users/resources and project tenants. Uses web-standard Fetch with bounded
transport and cancellation; depends only on the `mayura` peer.

See [the integration guide](../../docs/integrations/authz-permit.md) for installation, configuration, provisioning
identities, revision/consistency limitations, lifecycle, audit and server wiring.

The host provisions Permit policy/data and binds the supplied environment key to its PDP. The native response does
not attest a revision or synchronization watermark: configured environment/revision values are host assertions.
No provider writes, implicit sync, retries, decision cache, credential discovery or browser-supplied attributes.

## Primary references

Reviewed 2026-10-20. No SDK or live-provider calls were executed.

- [Permit check inputs and native PDP API](https://docs.permit.io/how-to/enforce-permissions/check/)
- [Official native request/response types](https://github.com/permitio/permit-node/blob/main/src/enforcement/interfaces.ts)
- [Official native /allowed request implementation](https://github.com/permitio/permit-node/blob/main/src/enforcement/enforcer.ts)
- [Native boolean response and optional result/query/debug fields](https://docs.permit.io/integrations/gateways/nginx/)
- [PDP data synchronization and model capabilities](https://docs.permit.io/concepts/pdp/overview/)

Offline regression tests are authored. Tests and all validation remain deferred.
