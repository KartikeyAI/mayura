# Authenticated operational CLI

Status: implementation contract for server inspection, human response, ephemeral-run control and explicit durable workflow control.

`@mayura/cli` exposes typed health/tool functions, typed human request list/inspect/respond functions, ephemeral-run inspect/wait/cancel functions and durable workflow list/inspect/cancel/exact-approval/signal functions. The executable additionally provides `workflow-list`, `workflow-get`, `workflow-cancel`, `workflow-approve` and `workflow-signal`. These commands consume the authenticated routes defined by the [HTTP agent transport](http-agent-transport.md), [workflow index](workflow-index-transport.md), [workflow control transport](workflow-control-transport.md) and [workflow signal transport](workflow-signal-transport.md). They do not submit runs, expose a generic resume operation, control fleets, migrate storage, load application modules or discover credentials.

## Credential and destination boundary

The library requires an explicit credential callback. The executable accepts a credential only through `--token-stdin` and refuses an interactive terminal; there is no token argument, query credential, environment-variable lookup, disk persistence or shell interpolation inside Mayura. Applications remain responsible for obtaining a short-lived token without placing it in process arguments or logs.

Human response values come from an explicit regular UTF-8 JSON file capped at 1 MiB. Links, directories, empty files, invalid encoding and invalid JSON are rejected. The command sends the exact request digest and command ID, never an actor or scope override; authenticated server identity supplies those. Successful output contains only validated request metadata and does not echo the submitted value.

Only exact HTTPS origins and loopback HTTP origins are accepted. Requests use `Authorization: Bearer`, omit cookies, disable caching, reject redirects and never retry. Timeouts cover credential resolution, transport and bounded response reads, including non-cooperative injected callbacks. Errors contain stable generic text and never include a token or response body.

Run inspection exposes status, budget totals and sanitized effect receipts only. Outcome output and error payloads are discarded even when the server returns them. `run-wait` performs bounded sequential read-only polling with a 250–10,000 ms interval and at most five minutes total; any failed read stops the wait. `run-cancel` sends exactly one bodyless command. An unavailable acknowledgement is reported as ambiguous failure and never causes an automatic retry. These routes currently control the server's bounded in-memory ephemeral runs, not durable scheduled/workflow records.

Workflow listing reads one explicit opaque-cursor page without automatic traversal. Inspection exposes only the exact content-free format 2–5 view and independently validates identities, vocabulary, topology, steps and child links. Cancellation sends `{ commandId, revision }`; approval additionally binds the node, approval digest and optional child run. Signal delivery binds a stable signal ID/name and at most 4 KiB of plain JSON read from a regular file. Commands are sent once, never retried, and HTTP revision conflicts become the stable `CONFLICT` error without exposing the response body or signal value. The CLI cannot choose actor, scope or authorized agent visibility.

## Response boundary

Readiness accepts HTTP 200 or the defined degraded HTTP 503 response, then validates the complete fixed report. A degraded dependency is observable state rather than a hidden transport error. Tool inspection reads exactly one explicit page of at most 100 metadata entries; it never follows a cursor automatically. Both results are immutable and reject unknown or malformed fields. Tool descriptions, schemas, prompts, handlers, credentials and server exception details are outside the wire contract.

Unit tests cover origin, credential header, degraded readiness, exact catalog shape, human pagination/inspection/response, run output withholding, bounded waits, cancellation ambiguity, workflow view/control validation, exact approval bodies, conflicts, hostile responses, callback timeout, real executable stdin boundaries and the bounded response-file path. The isolated packed CLI consumer type-checks and executes all operational, human, run and workflow operations without installing server/runtime packages.
