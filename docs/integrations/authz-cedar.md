---
title: "Cedar authorization"
description: "Local Cedar evaluation with scoped identities, pinned policies and schema, trusted attributes and core audit events."
package: "@mayurajs/authz-cedar"
vendor: "Cedar"
logo: "cedar"
website: "https://www.cedarpolicy.com"
area: "authz"
---

`@mayurajs/authz-cedar` connects a host-supplied native Cedar evaluator to the
[core authorization contract](../guides/authorization.md). It depends only on the `mayura` peer. The host installs,
initializes and pins its Cedar engine, including any WASM assets or worker. Importing or constructing the adapter
performs no evaluation or network request.

This slice supports stateless local Cedar evaluation with named static policies, a required Cedar schema source,
and trusted literal principal/resource attributes and context. Templates, entity hierarchies, entity references,
extension values and the Amazon Verified Permissions service are outside this adapter's current surface.
Native FFI shapes were reviewed on 2026-10-20; offline tests, types, docs and package checks passed locally; native engine interoperability remains unqualified.

## Install and configure

```bash
npm install mayura @mayurajs/authz-cedar
```

The evaluator must preserve the complete native `isAuthorized` result, including `type`, `response`,
`response.diagnostics` and `warnings`. A boolean-only wrapper cannot satisfy this contract.

```ts
import { createCedarAuthorizer, type CedarAuthorizationEvaluator } from '@mayurajs/authz-cedar';
import type { AuthorizationAuditSink } from 'mayura';

declare const evaluate: CedarAuthorizationEvaluator;
declare const auditSink: AuthorizationAuditSink;
const authorizer = createCedarAuthorizer({
  version: 'shop-policy-v1', engineVersion: 'cedar-engine-pinned-v1',
  namespace: 'shop-app', principalType: 'Shop::User', actionType: 'Shop::Action',
  mappings: [{ kind: 'thread', action: 'read', resourceType: 'Shop::Thread', actionId: 'read' }],
  schema: `namespace Shop {
    entity User = { canReadThreads: Bool };
    entity Thread;
    action read appliesTo { principal: User, resource: Thread, context: {} };
  }`,
  policies: {
    readThreads: `permit(principal is Shop::User,
      action == Shop::Action::"read", resource is Shop::Thread)
      when { principal.canReadThreads };`,
  },
  evaluate,
  // Use an authenticated, authoritative host lookup in production. Never trust browser-supplied attributes.
  attributes: () => ({ principal: { canReadThreads: true }, resource: {}, context: {} }),
  permissions: { allow: ['authz:cedar', 'authz:evaluate', 'authz:audit'] },
  timeoutMs: 750, limits: { timeoutMs: 1000, maxConcurrent: 32 },
  audit: { sink: auditSink },
});

const scope = { principalId: 'alice', projectId: 'shop' };
await authorizer.require(scope, 'read', { kind: 'thread', id: 'chat-1', scope });
await authorizer.flushAudit();
authorizer.close();
```

`createCedarAuthorizationPolicy` supplies the same adapter as a standalone core policy. Its pure
`identities(request)` helper returns native principal/action/resource UIDs for an exact mapping, or `null` for an
unmapped action. Invalid or mismatched scopes throw a fixed input error. Close a standalone policy explicitly.

## Identity and policy isolation

Every principal and resource UID is a SHA-256 digest of an ordered domain-separated identity containing namespace,
project and principal. Resource identities also contain the Mayura resource kind and ID. Two principals or projects
with identical resource IDs therefore cannot alias private objects, even when mapped to the same Cedar resource
type. The host chooses exact native action IDs; unmapped resource/action pairs deny before host callbacks.
`ownerId` alone never grants access. Request fields cannot override mappings, policies, schema, attributes or context.

The effective `policy.version` fingerprints host revision, engine version, namespace, principal/action types,
canonical named policy sources, schema and sorted mappings. Changing any of these changes core audit/cursor identity.
The host must bump `version` when changing attribute-source semantics or evaluator behavior. Dynamic attributes are
read for every check; there is no decision cache. Engine version is a host assertion, not runtime attestation.

Policies and mappings are copied at construction; evaluator calls receive fresh copies. The attribute callback gets
the copied/frozen scoped request and an abort signal, and must load data only for that verified scope. It is trusted
application code, not a sandbox. No callback can be supplied by an API request.

## Limits and failures

| Boundary | Limit |
| --- | --- |
| Named static policies | 1–256; total encoded policy map 262,144 bytes |
| Cedar schema source | 65,536 UTF-8 bytes |
| Exact action mappings | 1–512; 65,536 encoded bytes |
| Attribute snapshot | 16,384 encoded bytes; depth 8; 2,048 nodes |
| Native evaluation call | 360,448 encoded bytes; depth 12; 4,096 nodes |
| Native answer | 16,384 encoded bytes; depth 12; 2,048 nodes |
| Whole callback deadline | Default 1,000 ms; configurable 1–30,000 ms |
| Outstanding callback tasks | Default 32; configurable 1–256 |

Attributes support strings, booleans, safe integers, arrays as Cedar sets and nested records. Record keys must start
with an ASCII letter and contain only letters, digits or underscores, up to 64 characters. Null, fractional numbers,
entity/extension escapes, accessors, cycles and unsafe object keys are rejected. Native Cedar schema parsing and
request validation are requested on every evaluation; this does not replace policy validation before deployment.

Cedar normally skips policies that encounter evaluation errors. This adapter takes a stricter approach: any native
policy-evaluation error denies as `unavailable`, even if the native decision is `allow`. Parse failures, thrown or
rejected callbacks, malformed/oversized answers, unknown determining policy IDs and timeouts also deny without
exposing diagnostic text. Error-free native deny maps to `explicit_deny` when determining policies exist, otherwise
`no_match`. An allow must name at least one configured policy; a single determining policy becomes `ruleId`.
Multiple determining policies produce a null `ruleId`.

Timeout, cancellation and close settle the observable decision once. Uncooperative callbacks retain their concurrency
slot until they actually settle; a late allow cannot replace a denial. Cancellation during attribute loading prevents
subsequent evaluation. Synchronous WASM cannot be interrupted by a JavaScript timer; elapsed time is checked after
it returns. Use a host-owned worker with resource limits for hard CPU/memory isolation. The adapter closes neither
the evaluator nor the worker. It performs no retries, remote writes or paid model work.

## Server, audit and OpenTelemetry

Use the returned authorizer as `authorization` on a scoped server, as shown in
[server authorization](../guides/server-and-client.md#scoped-resource-authorization). Server scope resolution and operation
permissions still apply. `authz:cedar` admits the local host callbacks; it does not grant core `authz:evaluate`,
`authz:audit`, run permissions or tool writes.

Core enforcement owns the single final audit event. Provider diagnostics, policy text and attribute snapshots are
excluded. Pass the existing [OpenTelemetry audit sink](../guides/observability.md) through `audit`; there is no
second provider-specific event stream.

## Development status

Offline regression cases are authored for denial, input isolation, configuration fingerprints, malformed native
results, diagnostic errors, cancellation, retained capacity, timeouts and one core audit event. Offline tests, type checks, documentation and package checks passed locally. Real Cedar/WASM interoperability remains unqualified; see [release validation status](../guides/release-readiness.md). The [Permit.io adapter](authz-permit.md) is
implemented, as is the [Oso Cloud adapter](authz-oso.md); Amazon Verified Permissions service integration remains separate future work.
