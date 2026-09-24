# Authenticated operational CLI

Status: implementation contract for read-only server inspection.

`@mayura/cli` exposes typed `inspectServerHealth` and `inspectServerTools` functions plus `mayura server-health` and `mayura server-tools`. These commands consume the authenticated operational routes defined by the [HTTP agent transport](http-agent-transport.md). They do not submit or cancel runs, answer approvals, migrate storage, load application modules or discover credentials.

## Credential and destination boundary

The library requires an explicit credential callback. The executable accepts a credential only through `--token-stdin` and refuses an interactive terminal; there is no token argument, query credential, environment-variable lookup, disk persistence or shell interpolation inside Mayura. Applications remain responsible for obtaining a short-lived token without placing it in process arguments or logs.

Only exact HTTPS origins and loopback HTTP origins are accepted. Requests use `Authorization: Bearer`, omit cookies, disable caching, reject redirects and never retry. Timeouts cover credential resolution, transport and bounded response reads, including non-cooperative injected callbacks. Errors contain stable generic text and never include a token or response body.

## Response boundary

Readiness accepts HTTP 200 or the defined degraded HTTP 503 response, then validates the complete fixed report. A degraded dependency is observable state rather than a hidden transport error. Tool inspection reads exactly one explicit page of at most 100 metadata entries; it never follows a cursor automatically. Both results are immutable and reject unknown or malformed fields. Tool descriptions, schemas, prompts, handlers, credentials and server exception details are outside the wire contract.

Unit tests cover origin, credential header, degraded readiness, exact catalog shape, hostile responses, callback timeout and the real executable stdin boundary. The isolated packed CLI consumer type-checks and executes both operations without installing server/runtime packages.
