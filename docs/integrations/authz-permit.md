---
title: "Permit.io authorization"
description: "Native Permit.io PDP checks with explicit scoped identities, instance keys, environment credentials and core audit events."
package: "@mayurajs/authz-permit"
vendor: "Permit.io"
logo: "permit"
website: "https://www.permit.io"
area: "authz"
---

`@mayurajs/authz-permit` connects Permit.io's native PDP `POST /allowed` endpoint to Mayura's
[core authorization contract](../guides/authorization.md). This optional extension uses Fetch and depends only on the
`mayura` peer. Each evaluation sends one explicit user, action, resource instance and tenant. Construction performs
no requests. Provisioning, synchronization, retries and local allow caches are outside this adapter.

The native protocol was reviewed on 2026-10-20. Offline tests, type checks, docs and package checks passed locally; live-provider interoperability remains unqualified.

## Install and configure

```bash
npm install mayura @mayurajs/authz-permit
```

```ts
import { createPermitAuthorizer } from '@mayurajs/authz-permit';
import type { AuthorizationAuditSink } from 'mayura';

declare const environmentApiKey: string;
declare const auditSink: AuthorizationAuditSink;
const authorizer = createPermitAuthorizer({
  pdpUrl: 'https://pdp.example', apiKey: environmentApiKey,
  environmentId: 'production-env', version: 'shop-policy-v1', namespace: 'shop-app',
  mappings: [
    { kind: 'thread', action: 'read', resourceType: 'thread', permitAction: 'read' },
    { kind: 'tool', action: 'execute', resourceType: 'tool', permitAction: 'invoke' },
  ],
  permissions: { allow: ['authz:permit', 'authz:evaluate', 'authz:audit'] },
  timeoutMs: 750, limits: { timeoutMs: 1000, maxConcurrent: 32 },
  audit: { sink: auditSink },
});
const scope = { principalId: 'alice', projectId: 'shop' };
try {
  await authorizer.require(scope, 'read', { kind: 'thread', id: 'chat-1', scope });
} finally { await authorizer.flushAudit(); authorizer.close(); }
```

Use the address of a provisioned PDP and its authorized environment-scoped API key. The control-plane API is not
a decision endpoint. `pdpUrl` may include a fixed reverse-proxy prefix; the adapter appends `/allowed`. No host,
credential, tenant, action mapping or environment setting comes from the incoming request or environment variables.
The host installs TLS, resolves secrets and manages rotation. Construct a replacement policy to rotate fixed keys,
stop using the old policy, then close it. Key rotation within one environment does not change its configuration version.

HTTPS is required. For local development, `allowInsecureLoopback: true` permits HTTP only to literal `127.0.0.1` or
`::1`, including a chosen port. Hostnames such as `localhost`, URL credentials, queries and fragments are refused.
Cookies and browser credential forwarding are disabled; a fixed Bearer header carries the configured key.

`authz:permit` admits provider transport, `authz:evaluate` admits core evaluation, and `authz:audit` admits the optional
audit sink. Run grants, tool permissions and scoped server capabilities remain independently enforced.

## Scope and provisioning

Every mapping binds one exact Mayura resource kind/action pair to a native resource type/action. Duplicate pairs,
wildcards and malformed names fail configuration. Native type/action names start with an ASCII letter and contain
only letters, digits, underscores or hyphens, up to 128 characters. Unmapped requests deny locally as `no_match`.

Use the pure `input(request)` helper on a standalone policy to obtain the exact native keys for provisioning:

```ts
import { createPermitAuthorizationPolicy } from '@mayurajs/authz-permit';

declare const environmentApiKey: string;
const policy = createPermitAuthorizationPolicy({
  pdpUrl: 'https://pdp.example', apiKey: environmentApiKey,
  environmentId: 'production-env', version: 'shop-policy-v1', namespace: 'shop-app',
  mappings: [{ kind: 'thread', action: 'read', resourceType: 'thread', permitAction: 'read' }],
  permissions: { allow: ['authz:permit'] },
});
const scope = { principalId: 'alice', projectId: 'shop' };
const input = policy.input({ subject: scope, action: 'read', resource: { kind: 'thread', id: 'chat-1', scope } });
// input.user.key, input.resource.key and input.resource.tenant are deterministic provisioning identities.
// The helper performs no I/O; null means the resource/action is unmapped.
policy.close();
```

All keys are SHA-256 digests of ordered domain-separated identities:

| Native field | Identity inputs |
| --- | --- |
| `user.key` | Application namespace, project and principal |
| `resource.key` | Namespace, project, principal, resource kind and resource ID |
| `resource.tenant` | Namespace and project |

Principals within a project share its tenant but retain separate user and resource identities. Different projects,
applications, principals and resource kinds cannot alias private resources with identical local IDs. The helper
returns deeply frozen data and rejects malformed or mismatched scope. `ownerId` alone never grants access.

A separately authorized provisioning process must create the native resource types/actions, tenant, user, tenant
membership/role assignments, and required instances/attributes/relationships using these exact keys. Do not
provision raw Mayura IDs and expect hashed checks to match. There is no default-tenant fallback or type-wide check:
resource keys and tenant are always present. Do not grant type-wide roles unless that broad access is intended.

This slice sends an empty `context` and no inline user/resource attributes. Use authoritative data provisioned to a
PDP that supports your policy model. Caller-supplied roles, attributes, context, tenants and relationship overrides
are rejected rather than passed through. Native Cloud, container and Nexus capabilities differ; select an appropriate
PDP outside this adapter. Automatic data synchronization and provider administration are separate responsibilities.

## Revision and consistency limits

The effective `policy.version` fingerprints the endpoint, host-supplied `environmentId`, host revision, namespace
and sorted mappings. API keys and transport limits do not enter the fingerprint. Captured settings cannot be changed
by later caller mutation.

The native `/allowed` response does not attest a policy revision, environment identity or synchronization watermark.
`environmentId` and `version` are host assertions; they are not sent as unsupported pinning fields and are not checked
against a provider receipt. The host must bind credentials to the intended environment, control PDP rollout and
ensure required policy/data synchronization before admitting traffic. Bump `version` when changing policy semantics.
There is no decision cache, but this does not make Permit policy/data propagation strongly consistent.

## Bounded transport and denial

| Boundary | Limit |
| --- | --- |
| Exact action mappings | 1–512; 65,536 encoded bytes |
| Deadline | Default 1,000 ms; configurable 1–30,000 ms |
| Unsettled transport tasks | Default 32; configurable 1–256 |
| Request body | Default 8,192 bytes; configurable 1,024–16,384 |
| Response body | Default 2,048 bytes; configurable 256–16,384 |
| Decoded response JSON | Depth 8; 1,024 nodes |

Only an HTTP 200 JSON response with a boolean top-level `allow` can grant access. Optional native `result` must be the
same boolean. Bounded `query` and `debug` objects, or null values, are accepted and discarded. Unknown top-level
fields, nested OPA responses, bulk decisions, malformed metadata, wrong origins, redirects, media types, UTF-8,
response sizes, timeouts and transport failures deny as `unavailable`. Native `allow: false` becomes `no_match`;
the API does not identify an explicit forbid rule, so `ruleId` remains null. Diagnostic text never enters decisions.

Every request disables automatic redirects, cookies and caching. No check is retried. Cancellation and close settle
the observed decision once, propagate abort and prevent future checks. Ignored Fetch, body reads or stream
cancellation retain their concurrency slot until actual settlement; late allows cannot replace returned denials.

## Core audit and server wiring

`createPermitAuthorizationPolicy` implements the same core policy contract as the built-in RBAC and other adapters.
`createPermitAuthorizer` wraps it with core enforcement, audit and lifecycle ownership. Close standalone policies
explicitly; closing the convenience authorizer also closes its transport.

Use the standalone policy in the scoped server's `authorization` configuration as shown in
[the authorization guide](../guides/authorization.md). Server scope resolution and permissions still apply.
Core audit produces one final receipt per evaluation and excludes API keys, response queries and debug text. Reuse
[the OpenTelemetry audit sink](../guides/observability.md) through `audit`; provider-side logging remains independent.

Offline regression cases cover denied paths, malformed native responses, provisioning identity isolation, fixed
configuration, errors, ignored cancellation, retained capacity and one core audit event. These offline cases passed locally, as did type, documentation and package checks. Live-provider interoperability remains unqualified. The [Oso Cloud adapter](authz-oso.md) has the same qualification boundary; see [release validation status](../guides/release-readiness.md).
