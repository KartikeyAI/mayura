# Authenticated agent transport: ephemeral slice

Status: implementation contract. This is an optional transport around the verified ephemeral runtime, not the planned durable self-hosted server release.

## Architecture and API

`@mayura/server` exposes `createAgentServer(...).fetch(Request): Promise<Response>` and `close()`. It opens no listener, loads no credentials from the environment, and imports no native driver. The Fetch boundary is mounted by the optional loopback-only [Hono/Node host](node-local-host.md); protocol and authorization remain separate from adapter middleware. `@mayura/client` is browser-safe, has no runtime dependency, and uses an explicit Fetch transport and token callback. No React layer or UI is implied. Hostile strings remain data; applications should assign them with DOM `textContent`, with bounded `escapeHtmlText` available only when an HTML text-node encoding is required.

The trusted server configuration registers immutable agent definitions with fixed execution grants and limits. A mandatory Bearer authenticator returns a verified principal/project scope, permitted agent IDs, command capabilities and expiration. Requests cannot choose a model, tool, instructions, runtime scope, grants, price, or execution mode. The server supplies the verified scope to an isolated runtime. Authorization is rechecked on every object request and the owning scope must match exactly; a foreign ID behaves like a missing ID. Operational inspection has a separate `operations:read` capability and cannot be inferred from run authority.

| Route | Contract |
| --- | --- |
| `GET /healthz` | Disabled by default. When explicitly enabled, an unauthenticated content-free `{status:"ok"}` process-liveness response only. |
| `GET /v1/agents` | Authorized definition IDs and versions only. |
| `GET /v1/operations/health` | Capability `operations:read`; bounded configured readiness callbacks in parallel, returning only fixed IDs and `ready`/`unavailable` states. Degraded readiness is HTTP 503. |
| `GET /v1/tools?after=N&limit=N` | Capability `operations:read`; stable server-lifetime pagination over the caller's authorized agent tools. Metadata excludes descriptions, schemas, handlers and instructions. |
| `GET /v1/human-requests?after=CURSOR&limit=N` | Capability `humans:read`; application-adapted, scope/agent-filtered typed request metadata. |
| `GET /v1/human-requests/:id` | Capability `humans:read`; exact authorized request metadata or indistinguishable not-found. |
| `POST /v1/human-requests/:id/responses` | Capability `humans:respond`; exact `{commandId,requestDigest,value}`. The verified principal becomes the actor; clients cannot choose it. |
| `POST /v1/runs` | Exact `{agentId,input}` body, required `Idempotency-Key`, capability `runs:submit`; returns run ID/profile. |
| `GET /v1/runs/:id` | Capability `runs:read`; current metadata and guarded terminal outcome, never intermediate raw output. |
| `POST /v1/runs/:id/cancel` | Capability `runs:cancel`; idempotent cancellation request, not proof that effects stopped. No command body. |
| `GET /v1/runs/:id/events?after=N` | Capability `runs:read`; authenticated SSE metadata, bounded duration, explicit gap events, no provider events or secret content. |

Requests and responses use versioned route semantics and bounded plain JSON. Query credentials, unknown body fields, compressed request bodies and unexpected query parameters are rejected. Authentication failure is safe and uniform; callback failures never echo exception text. Readiness callbacks receive only the verified immutable scope and request cancellation signal. Non-cooperative callbacks retain bounded operational admission until they actually settle; timed-out work cannot create unbounded redispatch. Configured public origin prevents host confusion; browser origins require an exact allowlist. Cookies confer no authority. CORS allows only the documented methods/headers, never wildcard credential forwarding. TLS and proxy/header/body/socket limits remain the host adapter's responsibility.

## Idempotency, capacity and lifecycle

Submission identity is scoped to the verified principal/project plus its stable request key. A canonical digest includes agent ID/version and original input. Exact retries return the same current handle; different payloads conflict. Digest work precedes a synchronous inspect-and-admit section, so concurrent identical submissions cannot both start. No automatic submission retry occurs in the client.

This initial in-memory registry has explicit finite run/runtime/connection/request-body/readiness-operation bounds and no silent eviction: eviction of idempotency evidence could allow a repeated effect. The immutable tool catalog is sorted once at construction and numeric cursors are stable only for that server lifetime. Once full, admission fails until the owning server is replaced; that replacement loses ephemeral history. Restart-safe idempotency, durable quotas, indexed history and horizontally shared serving remain unimplemented. Disconnecting an observer does not cancel its run. Closing the server rejects new requests, closes observations and cancels its owned ephemeral runtimes.

Response streams are pull-driven and hold at most one encoded metadata event plus the runtime's bounded event buffer. Observation duration is capped by both server policy and the authentication expiry; reconnect must authenticate again. A token revoked before its stated expiry is not continuously checked by this first streaming adapter: choose short observation windows or add an external revocation layer. There are no result chunks before final output guards. Future cursors and unexpected observer failure emit a safe `stream.error` event and terminate; clients must not infer success from disconnection. Gap recovery uses the authorized run snapshot.

## Client boundary and qualification

The client receives an explicit base URL, credential callback and optional trusted Fetch implementation. It uses Authorization headers, omits cookies, rejects redirects, validates response envelopes and bounds bodies/frames. It does not accept server-supplied arbitrary navigation URLs, evaluate markup, load remote artifacts or import privileged agent/runtime code. Result typing requires a supplied output validator; a generic TypeScript cast alone is not validation. SSE parsing preserves sequence/cursor metadata and supports explicit reconnect, without retrying commands.

Tests cover missing/expired/throwing authentication, operational and human capability separation, public-liveness opt-in, readiness failure sanitization and retained callback admission, metadata-only catalog filtering/pagination, authenticated human request listing/inspection/response with server-derived actor identity, cross-scope reads/cancels/streams, request grant injection, origin/query credential rejection, body/registry/connection limits, simultaneous idempotency, safe errors, cancellation races, stream abort/gaps/expiry/backpressure, hostile-markup text encoding, browser-only import graph, split UTF-8/SSE frames, malformed/oversized replies and redirect handling. The packed optional-consumer profile proves the browser client installs alone, bundles without Node shims/globals, and does not pull server/runtime/native packages; the separate Node profile proves the authenticated loopback and human transport. These fixtures close V16 for this bounded transport. Durable serving, approvals/signals/artifacts, reverse-proxy deployment, a UI component framework and multi-host qualification remain separate capabilities.

The streaming protocol uses the standard SSE `event`, `id`, and `data` fields. A Fetch-based client supports explicit Authorization headers and abortable observation. See [MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) and [EventSource constructor](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource).
