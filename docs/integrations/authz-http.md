---
title: "HTTP authorization policies"
description: "External scoped authorization through a bounded HTTP policy protocol with core enforcement and audit receipts."
package: "@mayurajs/authz-http"
vendor: "HTTP authorization"
logo: "mayura"
website: "https://github.com/KartikeyAI/mayura"
area: "authz"
---

`@mayurajs/authz-http` connects a trusted remote policy service to Mayura's
[core authorization contract](../guides/authorization.md). The service resolves roles and policy membership itself
from verified principal/project identifiers. Nothing runs on import or construction. Every check is a bounded POST
with explicit transport permission, a pinned policy version and a unique request ID. A policy outage denies access.

This is the `mayura.authorization.v1` protocol, not a vendor-specific authorization API. Put a service implementing
this protocol in front of an external policy engine. The adapter installs no SDK, reads no environment variables,
and depends only on the `mayura` peer. It uses web-standard APIs on supported runtimes.

## Install

```bash
npm install mayura @mayurajs/authz-http
```

## Core enforcement and audit

```ts
import { createHttpAuthorizer } from '@mayurajs/authz-http';
import type { AuthorizationAuditSink } from 'mayura';

declare const serviceToken: string;
declare const auditSink: AuthorizationAuditSink;
const authorizer = createHttpAuthorizer({
  endpoint: 'https://policy.example/authorize',
  version: 'shop-v3',
  headers: { Authorization: `Bearer ${serviceToken}` },
  permissions: { allow: ['authz:http', 'authz:evaluate', 'authz:audit'] },
  timeoutMs: 750,
  limits: { timeoutMs: 1000, maxConcurrent: 32 },
  audit: { sink: auditSink },
});
try {
  const scope = { principalId: 'alice', projectId: 'shop' };
  await authorizer.require(scope, 'read', { kind: 'thread', id: 'chat', scope });
} finally {
  await authorizer.flushAudit();
  authorizer.close();
}
```

`authz:http` permits remote requests; without it the adapter returns `permission_denied` without transport activity.
`authz:evaluate` separately admits core evaluation. `authz:audit` separately admits the optional audit sink. The core
validates scope, policy decisions, deadlines and cancellation before returning an allow. Use an HTTP deadline shorter
than the core deadline so transport cleanup normally finishes within the enclosing check.

`createHttpAuthorizer` owns its remote policy and closes it with the core authorizer. An ordinary policy created by
`createHttpAuthorizationPolicy` can instead be passed to `createAuthorizer` or the scoped server. The host owns that
policy's lifecycle and closes it separately after stopping its users.

Audit events come from the core boundary exactly once per completed evaluation, including local denials, timeouts
and malformed responses. The HTTP adapter does not emit a second audit event. A late remote allow never replaces a
previous denial. Events contain validated identity/resource identifiers and the final receipt, not request bodies,
service credentials, raw provider responses or exception text. Audit delivery has its own permission, limits,
cancellation and gap counters. See [authorization audit events](../guides/authorization.md#authorization-audit-events)
and [OpenTelemetry authorization](../guides/authorization.md#opentelemetry-authorization).

## Scoped server

```ts
import { createHttpAuthorizationPolicy } from '@mayurajs/authz-http';
import { createAgentServer, type AgentServerOptions } from 'mayura/server';
import type { AuthorizationAuditSink } from 'mayura';

declare const serverOptions: Omit<AgentServerOptions, 'authorization'>;
declare const auditSink: AuthorizationAuditSink;
const policy = createHttpAuthorizationPolicy({
  endpoint: 'https://policy.example/authorize', version: 'shop-v3',
  permissions: { allow: ['authz:http'] }, timeoutMs: 750,
});
const server = createAgentServer({
  ...serverOptions,
  authorization: {
    policy,
    permissions: { allow: ['authz:evaluate', 'authz:audit'] },
    audit: { sink: auditSink },
  },
});
// Stop admitting requests before shutdown. Configure service authentication explicitly where required.
await server.flushAuthorizationAudit();
await server.close();
policy.close();
```

The server still checks token capabilities, agent visibility and scoped storage independently. Admission, dispatch,
response, filtering and stream checks can each call the policy and produce their own audit event. No decision cache
or automatic retry hides changes in remote membership. Configure and size the service for that check volume.
See [scoped resource authorization](../guides/server-and-client.md#scoped-resource-authorization) for action names.

## Wire protocol

The exported `HttpAuthorizationRequest` and `HttpAuthorizationResponse` types describe these envelopes for service implementers.
Requests are `POST` to the exact configured endpoint, with `Content-Type: application/json` and `Accept: application/json`:

```json
{
  "protocol": "mayura.authorization.v1",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "policyVersion": "shop-v3",
  "request": {
    "subject": { "principalId": "alice", "projectId": "shop" },
    "action": "read",
    "resource": {
      "kind": "thread",
      "id": "chat",
      "scope": { "principalId": "alice", "projectId": "shop" }
    }
  }
}
```

A trusted resource may also contain `ownerId`. Request fields come from the validated core contract; no browser role
claims, credentials or arbitrary attributes are forwarded. Subject and resource scopes must match before any network
request is admitted. The policy service must use its own trusted policy data to decide membership and ownership.

Answer HTTP 200 with a JSON object containing exactly these fields:

```json
{
  "protocol": "mayura.authorization.v1",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "decision": {
    "effect": "allow",
    "reason": "allowed",
    "policyVersion": "shop-v3",
    "ruleId": "read-thread"
  }
}
```

The protocol and request ID must match exactly, as must the pinned decision policy version. `ruleId` is a bounded
identifier or null. Denials use `effect: 'deny'` and a core denial reason, such as `explicit_deny` or `no_match`.
A valid denial is returned as a frozen receipt. Booleans, missing/extra fields, arbitrary reasons, stale revisions,
unrelated request IDs and malformed JSON deny with `unavailable` and null rule ID. Treat a business denial as a
normal HTTP 200 decision; non-200 HTTP responses mean the service could not provide an admitted decision.

## Transport limits and lifecycle

| Option | Default | Allowed bounds |
| --- | --- | --- |
| `timeoutMs` | 1,000 ms | 1–30,000 ms |
| `maxConcurrent` | 32 | 1–256 |
| `maxRequestBytes` | 8,192 UTF-8 bytes | 1,024–16,384 |
| `maxResponseBytes` | 2,048 decoded bytes | 256–16,384 |

Headers are copied at construction: at most 16 fixed entries and 8,192 bytes. Invalid, duplicate-case, cookie,
proxy, security and transport-control headers are refused. `Authorization` and service-specific credential headers
can be explicitly configured. Endpoint userinfo, query strings and fragments are refused. HTTPS is required; only
`allowInsecureLoopback: true` permits HTTP on literal `127.0.0.1` or `[::1]` for development, never a DNS hostname.

Fetch uses `redirect: 'error'`, `credentials: 'omit'`, `cache: 'no-store'`, and `referrerPolicy: 'no-referrer'`.
Only HTTP 200, unredirected JSON responses at the configured destination are admitted. Response bytes are limited
while streaming, including when no length header exists, and decoded as strict UTF-8. No response body or transport
exception is included in public errors, receipts or audit events. Custom `fetch` implementations are trusted code
and must preserve these transport controls; synchronous trusted callbacks cannot be preempted.

Caller cancellation and `close()` abort in-flight requests. Deadlines and failures return denials and never retry.
Outstanding fetch, read and body-cancellation work that ignores abort retains its capacity slot until it settles;
subsequent checks at capacity return `limit_exceeded`. There is no queue, decision cache, credential discovery,
background refresh, batching or fallback allow. A service billing per decision remains application-owned; use the
explicit concurrency/deadline limits and host rate limits to control load.

Rotate pinned policy revisions or fixed credentials by constructing a new policy and retiring the old one after its
users stop. Drain audit sinks before closing; flush/shut down any application telemetry SDK separately. This adapter
only evaluates access. It never executes a protected operation, resumes a run or replays tool writes.
