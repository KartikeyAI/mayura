# Authenticated operational CLI

Status: implementation contract for server inspection, human response and ephemeral-run control.

`@mayura/cli` exposes typed health/tool functions, typed human request list/inspect/respond functions, and ephemeral-run inspect/wait/cancel functions. The executable provides `server-health`, `server-tools`, `human-list`, `human-get`, `human-respond`, `run-get`, `run-wait` and `run-cancel`. These commands consume the authenticated routes defined by the [HTTP agent transport](http-agent-transport.md). They do not submit runs, control durable workflow fleets, answer exact-action tool approvals, migrate storage, load application modules or discover credentials.

## Credential and destination boundary

The library requires an explicit credential callback. The executable accepts a credential only through `--token-stdin` and refuses an interactive terminal; there is no token argument, query credential, environment-variable lookup, disk persistence or shell interpolation inside Mayura. Applications remain responsible for obtaining a short-lived token without placing it in process arguments or logs.

Human response values come from an explicit regular UTF-8 JSON file capped at 1 MiB. Links, directories, empty files, invalid encoding and invalid JSON are rejected. The command sends the exact request digest and command ID, never an actor or scope override; authenticated server identity supplies those. Successful output contains only validated request metadata and does not echo the submitted value.

Only exact HTTPS origins and loopback HTTP origins are accepted. Requests use `Authorization: Bearer`, omit cookies, disable caching, reject redirects and never retry. Timeouts cover credential resolution, transport and bounded response reads, including non-cooperative injected callbacks. Errors contain stable generic text and never include a token or response body.

Run inspection exposes status, budget totals and sanitized effect receipts only. Outcome output and error payloads are discarded even when the server returns them. `run-wait` performs bounded sequential read-only polling with a 250–10,000 ms interval and at most five minutes total; any failed read stops the wait. `run-cancel` sends exactly one bodyless command. An unavailable acknowledgement is reported as ambiguous failure and never causes an automatic retry. These routes currently control the server's bounded in-memory ephemeral runs, not durable scheduled/workflow records.

## Response boundary

Readiness accepts HTTP 200 or the defined degraded HTTP 503 response, then validates the complete fixed report. A degraded dependency is observable state rather than a hidden transport error. Tool inspection reads exactly one explicit page of at most 100 metadata entries; it never follows a cursor automatically. Both results are immutable and reject unknown or malformed fields. Tool descriptions, schemas, prompts, handlers, credentials and server exception details are outside the wire contract.

Unit tests cover origin, credential header, degraded readiness, exact catalog shape, human pagination/inspection/response, run output withholding, bounded waits, cancellation ambiguity, hostile responses, callback timeout, real executable stdin boundaries and the bounded response-file path. The isolated packed CLI consumer type-checks and executes all operational, human and run operations without installing server/runtime packages.
