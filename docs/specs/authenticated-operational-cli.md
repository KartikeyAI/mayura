# Authenticated operational CLI

Status: implementation contract for read-only server inspection.

`@mayura/cli` exposes typed health/tool functions plus typed human request list, inspect and respond functions. The executable provides `server-health`, `server-tools`, `human-list`, `human-get` and `human-respond`. These commands consume the authenticated routes defined by the [HTTP agent transport](http-agent-transport.md). They do not submit or cancel runs, answer exact-action tool approvals, migrate storage, load application modules or discover credentials.

## Credential and destination boundary

The library requires an explicit credential callback. The executable accepts a credential only through `--token-stdin` and refuses an interactive terminal; there is no token argument, query credential, environment-variable lookup, disk persistence or shell interpolation inside Mayura. Applications remain responsible for obtaining a short-lived token without placing it in process arguments or logs.

Human response values come from an explicit regular UTF-8 JSON file capped at 1 MiB. Links, directories, empty files, invalid encoding and invalid JSON are rejected. The command sends the exact request digest and command ID, never an actor or scope override; authenticated server identity supplies those. Successful output contains only validated request metadata and does not echo the submitted value.

Only exact HTTPS origins and loopback HTTP origins are accepted. Requests use `Authorization: Bearer`, omit cookies, disable caching, reject redirects and never retry. Timeouts cover credential resolution, transport and bounded response reads, including non-cooperative injected callbacks. Errors contain stable generic text and never include a token or response body.

## Response boundary

Readiness accepts HTTP 200 or the defined degraded HTTP 503 response, then validates the complete fixed report. A degraded dependency is observable state rather than a hidden transport error. Tool inspection reads exactly one explicit page of at most 100 metadata entries; it never follows a cursor automatically. Both results are immutable and reject unknown or malformed fields. Tool descriptions, schemas, prompts, handlers, credentials and server exception details are outside the wire contract.

Unit tests cover origin, credential header, degraded readiness, exact catalog shape, human pagination/inspection/response, hostile responses, callback timeout, the real executable stdin boundary and the bounded response-file path. The isolated packed CLI consumer type-checks and executes all read-only and human operations without installing server/runtime packages.
