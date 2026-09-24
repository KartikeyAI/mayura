# @mayura/client

Experimental browser-safe HTTP/SSE client. It includes authenticated typed human-request listing, inspection and digest-bound response submission. No server/runtime/native dependencies, automatic command retries, credential persistence or markup execution. Configure the base URL and token callback explicitly; validate final output with your application schema. Assign untrusted strings through DOM `textContent`; `escapeHtmlText` is the bounded fallback for HTML text-node encoding. See the repository's `docs/specs/http-agent-transport.md`.

The dependency-free `@mayura/client/headless` subpath provides an inert external run store and text-only human-request view metadata for React/Vue/Svelte/DOM adapters. Network reads, SSE observation and cancellation remain explicit; disposal stops local observation but never cancels a run. It is not a policy engine or HTML sanitizer.
