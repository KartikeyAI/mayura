# `@mayurajs/authz-http`

An optional HTTP authorization policy adapter for Mayura's core contract. Implements the explicit
`mayura.authorization.v1` protocol with pinned policy revisions, per-request correlation, strict bounded JSON,
HTTPS transport, explicit `authz:http` permission and fail-closed receipts. No vendor SDK, automatic retries,
redirects, cookies, implicit credentials, decision cache or network activity on construction.

```ts
import { createHttpAuthorizer } from '@mayurajs/authz-http';

const authorizer = createHttpAuthorizer({
  endpoint: 'https://policy.example/check', version: 'shop-v3',
  permissions: { allow: ['authz:http', 'authz:evaluate'] },
  timeoutMs: 750, limits: { timeoutMs: 1000 },
});
const scope = { principalId: 'alice', projectId: 'shop' };
try { await authorizer.require(scope, 'read', { kind: 'thread', id: 'chat', scope }); }
finally { await authorizer.flushAudit(); authorizer.close(); }
```

Optional `audit` settings and `authz:audit` forward to the core authorizer. Audit/OTel consumers receive one final core
receipt, never credentials, raw provider payloads or exception text. `createHttpAuthorizationPolicy` instead returns a
plain core-compatible policy with an explicit `close()`; pass it to `createAuthorizer` or the scoped server and close
it separately when finished. Each check makes a fresh request; configure host rate limits for your service's cost.

The full protocol, transport bounds, service authentication and server/audit wiring are documented in
[HTTP authorization policies](../../docs/integrations/authz-http.md).
