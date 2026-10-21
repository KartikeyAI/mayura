# `@mayurajs/authz-openfga`

Optional native OpenFGA Check adapter for Mayura's scoped authorization contract. Requires `authz:openfga`, an explicit
API endpoint, a pinned store/model, an application namespace and exact resource/action-to-relation mappings. No SDK,
network activity on construction, relationship writes, retries, redirects, implicit credentials or local decision cache.

```ts
import { createOpenFgaAuthorizer } from '@mayurajs/authz-openfga';

const authorizer = createOpenFgaAuthorizer({
  apiUrl: 'https://fga.example',
  storeId: '01YCP46JKYM8FJCQ37NMBYHE5X',
  authorizationModelId: '01G5JAVJ41T49E9TT3SKVS7X1J',
  version: 'shop-v1', namespace: 'shop-app', userType: 'principal',
  relations: [{ kind: 'thread', action: 'read', objectType: 'scoped_resource', relation: 'can_read' }],
  permissions: { allow: ['authz:openfga', 'authz:evaluate'] },
  timeoutMs: 750, limits: { timeoutMs: 1000 },
});
try {
  const scope = { principalId: 'alice', projectId: 'shop' };
  await authorizer.require(scope, 'read', { kind: 'thread', id: 'chat', scope });
} finally { await authorizer.flushAudit(); authorizer.close(); }
```

The example IDs must be replaced with your provisioned OpenFGA store/model and corresponding relationships.
`createOpenFgaAuthorizationPolicy` returns a core-compatible policy with `tuple(request)` for deterministic offline
relationship provisioning. Both subjects and objects include the full verified principal/project scope and namespace;
identical resource IDs cannot alias across scopes or kinds. Unmapped actions and cross-scope requests never reach
OpenFGA. The effective `policy.version` fingerprints the model and host mapping, rather than claiming a provider
response revision. A false boolean becomes `no_match`; transport errors deny with fixed metadata. Trace data is discarded.

Configure service authentication through explicit fixed `headers`. The adapter neither reads environment variables
nor obtains/refreshes tokens. Core `authz:evaluate` and optional `authz:audit` remain separate grants. Audit and OTel
use the core's single final receipt without provider bodies, credentials or trace text. No model or tuple management
permissions are required by this read-only adapter. Relationship provisioning remains a separately authorized host task.

Full setup, graph identity encoding, consistency and server wiring: [OpenFGA authorization](../../docs/integrations/authz-openfga.md).
Implementation and offline regression cases are development work; tests, SDK interoperability and validation remain deferred.

Protocol references reviewed **2026-10-20**: [OpenFGA Check API definition](https://github.com/openfga/api/blob/main/openfga/v1/openfga_service.proto),
[performing checks](https://openfga.dev/docs/getting-started/perform-check) and
[query consistency](https://openfga.dev/docs/interacting/consistency). The adapter always supplies the model ID and
`HIGHER_CONSISTENCY`; this preference does not promise transactional coupling with application writes.
