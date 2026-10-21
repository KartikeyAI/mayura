---
title: "OpenFGA authorization"
description: "Native OpenFGA checks with pinned models, explicit scoped relation mappings and core authorization audit events."
package: "@mayurajs/authz-openfga"
vendor: "OpenFGA"
logo: "openfga"
website: "https://openfga.dev"
area: "authz"
---

`@mayurajs/authz-openfga` connects OpenFGA's native Check API to Mayura's [core authorization](../guides/authorization.md)
contract. It is an optional extension, separate from the bundled RBAC implementation and the
[generic HTTP policy protocol](authz-http.md). The adapter uses Fetch and depends only on the `mayura` peer.

Each mapped evaluation sends one bounded `POST /stores/:storeId/check` with a pinned `authorization_model_id`,
a native tuple and `HIGHER_CONSISTENCY`. It performs no relationship writes, model discovery, retries or local caching.
Failures deny access. Protocol behavior was reviewed against the upstream API definitions on 2026-10-20; SDK and
live-provider interoperability checks remain unqualified; offline tests passed locally.

## Install and configure

```bash
npm install mayura @mayurajs/authz-openfga
```

```ts
import { createOpenFgaAuthorizer } from '@mayurajs/authz-openfga';
import type { AuthorizationAuditSink } from 'mayura';

declare const serviceToken: string;
declare const auditSink: AuthorizationAuditSink;
const authorizer = createOpenFgaAuthorizer({
  apiUrl: 'https://fga.example',
  storeId: '01YCP46JKYM8FJCQ37NMBYHE5X',
  authorizationModelId: '01G5JAVJ41T49E9TT3SKVS7X1J',
  version: 'shop-v1', namespace: 'shop-app', userType: 'principal',
  relations: [
    { kind: 'thread', action: 'read', objectType: 'scoped_resource', relation: 'can_read' },
    { kind: 'tool', action: 'execute', objectType: 'scoped_resource', relation: 'can_execute' },
  ],
  headers: { Authorization: `Bearer ${serviceToken}` },
  permissions: { allow: ['authz:openfga', 'authz:evaluate', 'authz:audit'] },
  timeoutMs: 750, limits: { timeoutMs: 1000, maxConcurrent: 32 },
  audit: { sink: auditSink },
});
try {
  const scope = { principalId: 'alice', projectId: 'shop' };
  await authorizer.require(scope, 'read', { kind: 'thread', id: 'chat', scope });
} finally { await authorizer.flushAudit(); authorizer.close(); }
```

Replace the example IDs and token with a provisioned store, model and authorized service identity. `apiUrl` can include
a fixed reverse-proxy prefix. Store/model IDs are explicit 26-character native IDs; an empty ID never selects a latest
model. Use HTTPS. For local development only, `allowInsecureLoopback: true` accepts literal `127.0.0.1` or `::1` over
HTTP; hostnames such as `localhost` are refused. Embedded URL credentials, queries, fragments and browser cookie
headers are refused. Credentials are snapshotted from host `headers`, never forwarded from caller input or discovered
from environment variables. Token acquisition/refresh belongs to the host; construct a replacement policy when rotating
fixed credentials and stop the old policy's users before closing it.

`authz:openfga` separately permits provider I/O. Without it, no check reaches OpenFGA. `authz:evaluate` admits the core
enforcement layer; `authz:audit` admits an optional audit sink. Nothing is implicitly authorized by setting up a connection.

## Explicit mappings and graph provisioning

Every host mapping names one exact Mayura resource kind/action and one OpenFGA object type/relation. Duplicate
kind/action pairs, wildcard names, usersets and malformed names are rejected. An unmapped action returns `no_match`
without I/O; no action is automatically converted into a relation. Required model/principal/tool/runtime grants and
scoped server capabilities remain independently enforced.

The pinned authorization model must define the configured types and relations. A minimal example uses:

```text
model
  schema 1.1

type principal

type scoped_resource
  relations
    define can_read: [principal]
    define can_execute: [principal]
```

The adapter does not create this model or grant relationships. Use a separately authorized provisioning process.
Obtain exact tuple identities through the pure `policy.tuple(request)` helper:

```ts
import { createOpenFgaAuthorizationPolicy } from '@mayurajs/authz-openfga';

const policy = createOpenFgaAuthorizationPolicy({
  apiUrl: 'https://fga.example', storeId: '01YCP46JKYM8FJCQ37NMBYHE5X',
  authorizationModelId: '01G5JAVJ41T49E9TT3SKVS7X1J', version: 'shop-v1', namespace: 'shop-app', userType: 'principal',
  relations: [{ kind: 'thread', action: 'read', objectType: 'scoped_resource', relation: 'can_read' }],
  permissions: { allow: ['authz:openfga'] },
});
const scope = { principalId: 'alice', projectId: 'shop' };
const tuple = policy.tuple({ subject: scope, action: 'read', resource: { kind: 'thread', id: 'chat', scope } });
// Hand this tuple to your separately authorized relationship provisioner; this helper performs no I/O.
void tuple;
policy.close();
```

Subject IDs hash the versioned subject domain, namespace, project ID and principal ID. Object IDs hash a separate
versioned resource domain, the same full scope, resource kind and resource ID. Inputs use ordered JSON arrays and
SHA-256; resulting native IDs are `<type>:<64 lowercase hex characters>`. Resource kinds cannot alias even when
mapped to the same OpenFGA object type. The adapter's namespace must remain stable across replicas and provisioning
jobs. These opaque identifiers are deterministic identity encodings, not encryption or a claim that identifiers
cannot be guessed.

Full principal **and** project scope is intentional: a private Mayura thread named `chat` in Alice's scope must not
alias Bob's thread with the same ID. Broad project-only object identities would merge distinct native resources.
This profile therefore does not reinterpret existing shared-object tuples that use unscoped native IDs. Provision
relationships for the actual verified Mayura scope. A resource `ownerId` is validated metadata, not an implicit owner
grant or a contextual relationship. Core cross-scope checks remain mandatory.

Callers cannot supply OpenFGA usersets, wildcards, contextual tuples, condition context, model IDs, service credentials
or policy endpoints. Conditional relationships that require extra context will fail closed in this initial profile;
provide a host-reviewed integration before relying on such conditions. Only the explicit bounded Check API is exposed.

## Versioning and decision receipts

`options.version` names the host revision. The effective `policy.version` is `openfga:` followed by a fingerprint of
that revision, endpoint/store, pinned model, namespace, user type and sorted exact mappings. Reordering mappings does
not change the fingerprint; changing their meaning or target does. Fixed credentials and transport bounds are excluded.
This binds scoped authorization cursors and audit receipts to the actual model/mapping configuration across replicas.

OpenFGA's Check response supplies a boolean, not the generic HTTP adapter's correlated revision receipt. The adapter
trusts the configured HTTPS service to evaluate the pinned request; it never invents an echoed revision or a matched
rule ID. Only a strict boolean `allowed` is used. Optional bounded string `resolution` trace data is discarded. False
becomes `no_match`; malformed/unknown fields, provider errors, redirects and transport failures become fixed denials.
Every decision has `ruleId: null`. The fingerprint identifies the pinned model/mapping, not a revision of mutable
relationship tuples.

The transport requests higher consistency and retains no local allow cache. That provider preference is not an
application transaction fence: relationship changes can race application writes. Recheck at protected effect and
output boundaries through the existing core runtime/server/tool contracts. Configure service rate/cost limits and
capacity outside this adapter; each mapped evaluation spends one provider request.

## Scoped server and audit

```ts
import { createOpenFgaAuthorizationPolicy } from '@mayurajs/authz-openfga';
import { createAgentServer, type AgentServerOptions } from 'mayura/server';

declare const serverOptions: Omit<AgentServerOptions, 'authorization'>;
const policy = createOpenFgaAuthorizationPolicy({
  apiUrl: 'https://fga.example', storeId: '01YCP46JKYM8FJCQ37NMBYHE5X',
  authorizationModelId: '01G5JAVJ41T49E9TT3SKVS7X1J', version: 'shop-v1', namespace: 'shop-app', userType: 'principal',
  relations: [{ kind: 'thread', action: 'read', objectType: 'scoped_resource', relation: 'can_read' }],
  permissions: { allow: ['authz:openfga'] }, timeoutMs: 750,
});
const server = createAgentServer({ ...serverOptions, authorization: {
  policy, permissions: { allow: ['authz:evaluate'] }, limits: { timeoutMs: 1000 },
} });
await server.close();
policy.close();
```

This narrow mapping is illustrative; map every action your server actually needs before serving callers. Missing
server/runtime actions fail closed. The scoped server still validates authentication, agent visibility, resource scope,
capabilities, write admission and stream disclosure independently.

`createOpenFgaAuthorizer` owns the core and remote policy lifecycles. With a standalone policy supplied to
`createAuthorizer` or a scoped server, the host closes that policy separately. Shutdown aborts admitted provider work
and denies new checks. It never writes relationships or creates a second audit event.

Audit events and [OpenTelemetry authorization](../guides/authorization.md#opentelemetry-authorization) use the existing
core pipeline once per final evaluation. They include validated resource/identity metadata, the effective version and
final decision. Provider traces, response bodies, service credentials and raw exceptions are excluded. A late allow
cannot overwrite a timeout or cancellation denial.

## Bounds and failure behavior

| Setting | Default | Accepted range |
| --- | --- | --- |
| `timeoutMs` | 1000 ms | 1–30000 ms |
| `maxConcurrent` | 32 I/O tasks | 1–256 |
| `maxRequestBytes` | 8192 bytes | 1024–16384 |
| `maxResponseBytes` | 2048 decoded bytes | 256–16384 |

Mappings are bounded to 512 entries and 64 KiB; fixed headers to 16 entries and 8 KiB. Runtime request copying and
response parsing also bound JSON depth/nodes. Use a transport deadline shorter than the enclosing core authorization
deadline. A blocked fetch, response read or body cancellation keeps its I/O slot until actual settlement, even after
the caller has received a denial. This prevents ignored aborts from opening unbounded transport work.

No evaluation retries rate limits, provider outages or ambiguous replies. Configure availability and operational
alerting in the host; an unavailable service cannot become an allow. Offline tests, type checks, documentation and package checks passed locally. Live-provider/SDK interoperability remains unqualified; see [release validation status](../guides/release-readiness.md).
