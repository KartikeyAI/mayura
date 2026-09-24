# @mayura/client

Experimental browser-safe HTTP/SSE client. It includes authenticated typed human-request listing, inspection and digest-bound response submission. No server/runtime/native dependencies, automatic command retries, credential persistence or markup execution. Configure the base URL and token callback explicitly; validate final output with your application schema. Assign untrusted strings through DOM `textContent`; `escapeHtmlText` is the bounded fallback for HTML text-node encoding. See the repository's `docs/specs/http-agent-transport.md`.

The dependency-free `@mayura/client/headless` subpath provides an inert external run store, conservative content-free activity projection and text-only human-request view metadata for React/Vue/Svelte/DOM adapters. Network reads, SSE observation and cancellation remain explicit; disposal stops local observation but never cancels a run. It is not a policy engine, workflow graph or HTML sanitizer.

React applications may add the separate `@mayura/client-react` peer adapter. The base client remains framework-independent.

The dependency-free `@mayura/client/workflows` subpath validates deeply immutable, content-free durable workflow views and projects bounded DAG nodes, edges, depths, readiness and progress. A trusted application adapter must derive the view from a matched authoritative manifest and snapshot; this is not an execution or mutation API.

`MayuraClient.workflow(runId)` reads one authenticated content-free durable view from a configured Mayura server. It performs no polling or retry; pass the result to the workflow projector for semantic DAG validation.

`cancelWorkflow` and `approveWorkflow` send one explicit revision-bound command with a caller-owned stable command ID. They never retry; the configured server adapter remains responsible for durable command journaling and conflict semantics.

The dependency-free `@mayura/client/forms` subpath captures a finite schema-driven human-response form and validates a frozen browser draft into a typed value bound to the exact authenticated request ID and digest. Its optional caller-owned response controller provides explicit single-flight pending/success/conflict/failure state around the authenticated client command. Construction performs no work and submission never retries automatically.
