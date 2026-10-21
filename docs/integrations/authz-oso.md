---
title: "Oso authorization"
description: "Native Oso Cloud authorization checks with scoped typed identities, explicit credentials, bounded transport and core audit events."
package: "@mayurajs/authz-oso"
vendor: "Oso"
logo: "oso"
website: "https://www.osohq.com"
area: "authz"
---

`@mayurajs/authz-oso` connects the Oso Cloud single-check `POST /api/authorize` endpoint to the
[core authorization contract](../guides/authorization.md). It is an optional Fetch-based extension with only the
`mayura` peer. The host deploys Polar policy, provisions facts and supplies credentials. The adapter sends a scoped
actor, action and resource; it performs no policy/fact writes, automatic synchronization, retries or local caching.

This adapter targets Oso Cloud's centralized HTTP checks. Embedded Oso library evaluation, local SQL authorization,
list filtering, context facts and provider administration are outside this slice. Native API behavior was reviewed on
2026-10-20; offline tests, type checks, docs and package checks passed locally; SDK/live-service interoperability remains unqualified.

## Install and configure

```bash
npm install mayura @mayurajs/authz-oso
```

```ts
import { createOsoAuthorizer } from '@mayurajs/authz-oso';
import type { AuthorizationAuditSink } from 'mayura';

declare const environmentApiKey: string;
declare const auditSink: AuthorizationAuditSink;
const authorizer = createOsoAuthorizer({
  apiUrl: 'https://api.osohq.com', apiKey: environmentApiKey,
  environmentId: 'production-env', version: 'shop-policy-v1', namespace: 'shop-app', actorType: 'User',
  mappings: [
    { kind: 'thread', action: 'read', resourceType: 'Thread', osoAction: 'read' },
    { kind: 'tool', action: 'execute', resourceType: 'Tool', osoAction: 'invoke' },
  ],
  permissions: { allow: ['authz:oso', 'authz:evaluate', 'authz:audit'] },
  timeoutMs: 750, limits: { timeoutMs: 1000, maxConcurrent: 32 },
  audit: { sink: auditSink },
});
const scope = { principalId: 'alice', projectId: 'shop' };
try {
  await authorizer.require(scope, 'read', { kind: 'thread', id: 'chat-1', scope });
} finally { await authorizer.flushAudit(); authorizer.close(); }
```

`apiUrl` is an explicit service base URL. A fixed reverse-proxy prefix is supported; the adapter appends
`/api/authorize`. Provide the service origin, rather than a URL already ending in `/api`. Construction performs no
network requests or credential discovery. The host supplies a fixed environment key, resolves secrets and configures
TLS. Construct a replacement policy when rotating keys, stop using the old policy and close it. Rotating keys within
the same environment does not alter its effective configuration version.

HTTPS is required. The development-only `allowInsecureLoopback: true` exception permits HTTP to literal `127.0.0.1`
or `::1`, including a selected port. Hostnames such as `localhost`, embedded URL credentials, queries and fragments
are refused. The adapter sends its fixed Bearer header with no cookies, ambient credentials, redirects or caching.

Provider I/O requires `authz:oso`. Core enforcement requires `authz:evaluate`; an audit sink additionally requires
`authz:audit`. Runtime/model/tool grants and scoped server capabilities still apply independently.

## Identity mapping and fact provisioning

Each mapping binds one exact Mayura resource kind/action pair to an Oso resource type/action. Unmapped pairs deny
locally as `no_match`. Duplicate pairs and wildcard mappings are rejected. This adapter's native type-name subset
starts with an uppercase ASCII letter and contains letters, digits or underscores, up to 128 characters. Native
actions start with a lowercase letter and contain lowercase letters, digits, underscores or hyphens, up to 128
characters. These are adapter bounds, not a claim about all names supported by Polar.

Use a standalone policy's pure `input(request)` helper to derive the exact typed IDs needed by a separately
authorized provisioning process:

```ts
import { createOsoAuthorizationPolicy } from '@mayurajs/authz-oso';

declare const environmentApiKey: string;
const policy = createOsoAuthorizationPolicy({
  apiUrl: 'https://api.osohq.com', apiKey: environmentApiKey,
  environmentId: 'production-env', version: 'shop-policy-v1', namespace: 'shop-app', actorType: 'User',
  mappings: [{ kind: 'thread', action: 'read', resourceType: 'Thread', osoAction: 'read' }],
  permissions: { allow: ['authz:oso'] },
});
const scope = { principalId: 'alice', projectId: 'shop' };
const input = policy.input({ subject: scope, action: 'read', resource: { kind: 'thread', id: 'chat-1', scope } });
if (input) {
  const actor = { type: input.actor_type, id: input.actor_id };
  const resource = { type: input.resource_type, id: input.resource_id };
  // Use these exact typed values when provisioning policy facts outside the request path.
  void actor; void resource;
}
policy.close();
```

Actor IDs hash an ordered, domain-separated identity containing application namespace, project and principal.
Resource IDs include the same full scope plus resource kind and ID, with a separate domain. Different principals,
projects, applications and kinds cannot alias private resources with the same local ID, even when mapped to the same
native type. Actor and resource identities also remain distinct when they share a native type and local identifier.
The helper returns frozen native input, returns null for an unmapped action, and throws fixed errors for invalid or
mismatched scope. `ownerId` alone never grants access.

The deployed Polar policy must declare the configured actor/resource types and recognize the mapped actions.
Provision roles, relationships and attributes using the generated typed identities. Provisioning raw Mayura IDs
will not match these checks. The adapter never inserts missing facts or deploys a policy when a check denies.

The native body contains only `actor_type`, `actor_id`, `action`, `resource_type` and `resource_id`. Caller-supplied
facts, roles, variables, policy source, provider keys and endpoint overrides are rejected. No `context_facts` are
sent. Host-specific data synchronization belongs to a separate authorized process with its own replay guarantees.

## Revision and consistency

The effective `policy.version` fingerprints the service endpoint, asserted environment ID, host revision, namespace,
actor type and canonically sorted mappings. Credentials and transport limits are excluded. Configuration is copied
at construction; changing the original object does not change admitted checks.

The single-check API returns an authorization boolean, without a policy-version, environment or fact-watermark
receipt. `environmentId` and `version` are host assertions. They are not unsupported wire fields or verified native
policy pins. The host must bind the key to the intended environment, deploy policy/data changes and manage readiness
before routing traffic. Bump `version` when policy or data-source semantics change. The adapter has no local decision
cache, but makes no stronger synchronization guarantee than the configured Oso service.

## Bounds and denial behavior

| Boundary | Limit |
| --- | --- |
| Exact mappings | 1–512; 65,536 encoded bytes |
| Per-check deadline | Default 1,000 ms; configurable 1–30,000 ms |
| Unsettled I/O tasks | Default 32; configurable 1–256 |
| Encoded request bytes | Default 8,192; configurable 1,024–16,384 |
| Decoded response bytes | Default 2,048; configurable 256–16,384 |

Only HTTP 200 JSON containing the single native `allowed` boolean is accepted. False maps to `no_match`; true
maps to an allow with null `ruleId` because the native response does not identify determining rules. Truthy strings,
extra fields, duplicate decision keys, nested/list results, provider errors, invalid media/UTF-8/JSON, oversized
responses, wrong response origins, redirects and timeouts deny as `unavailable`. Raw errors and credentials never
enter returned decisions or core audit.

Cancellation and close settle the observed decision once and propagate abort. A Fetch, body read or body cancellation
that ignores abort retains its concurrency slot until it actually settles. Late allows cannot replace a denial, and
no check is retried. Closing the convenience authorizer also closes its policy transport; standalone policies must
be closed explicitly. This lifecycle never replays provider writes, tool effects or paid model work.

## Server, audit and OpenTelemetry

`createOsoAuthorizationPolicy` implements the same core policy contract as built-in RBAC and the other providers.
Use it in the scoped server's `authorization` configuration as described in
[the authorization guide](../guides/authorization.md). Verified scope resolution, operation capabilities and existing
authorization enforcement still apply.

`createOsoAuthorizer` adds core enforcement and optional audit. Core emits one final receipt per evaluation; there
is no parallel provider-specific audit stream. Reuse [the OpenTelemetry sink](../guides/observability.md) through
`audit`. Oso's own service logs are independent of the core sink.

Offline cases cover allowed/denied decisions, scoped identities, injection attempts, malformed replies, configuration
fingerprints, failures, ignored cancellation/stream cleanup, retained capacity, late results and core audit. These offline cases passed locally, as did type, documentation and package checks. SDK/live-service interoperability remains unqualified for Oso and the other provider adapters; see [release validation status](../guides/release-readiness.md).
