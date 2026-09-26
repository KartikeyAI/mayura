# Production server host

Status: **implemented for v1 hardening; container packaging, workers and migrations are tracked separately in the [v1 plan](../v1-release-plan.md)**.

`listenProductionServer` (from `@mayura/server-node`) serves the same authenticated protocol as the loopback host, for deployment behind a load balancer or directly on a network interface. Nothing about it is implicit:

- **Binding.** `hostname` and `port` are required. There is no default interface.
- **Origin.** `publicOrigin` must be an exact `https://` origin with no path, query or credentials. The protocol only accepts requests whose destination equals it.
- **TLS.** Exactly one of `tls: { key, cert }` (in-process, minimum TLS 1.2) or `tls: { terminatedBy: 'proxy' }`. The second declares that a trusted TLS-terminating proxy is in front; the listener itself then speaks plain HTTP and must not be reachable except through that proxy.
- **Host check.** Every protocol request must carry a `Host` header equal to the public host, otherwise it is answered `421 MISDIRECTED_REQUEST` before authentication. The canonical public URL is rebuilt from the path and query; the listener's own scheme and address are never trusted as the destination.
- **Probes.** `GET /livez` and `GET /readyz` are unauthenticated, content-free and exempt from the host check because orchestrators address pods directly. Readiness is false before startup completes and from the instant shutdown begins; an optional `readiness(signal)` callback (for example a storage ping) is bounded to 2 seconds and any failure reports not ready without detail.
- **Headers.** Every protocol response carries `Strict-Transport-Security` (`hstsMaxAgeSeconds`, default one year; 0 disables it) in addition to the protocol's own no-store and no-sniff headers.
- **Limits.** The loopback host's socket, header, request, keep-alive and upgrade limits apply; `maxConnections` defaults to 1,024.
- **Shutdown.** `close()` fails readiness immediately, stops accepting, lets in-flight requests finish within `shutdownGraceMs` (default 30 s, maximum 120 s) and then closes runs and streams. Pair it with the workflow worker `drain` for background work.

## Durable submission idempotency

HTTP runs remain the `ephemeral` profile: their state lives in one process. Without further configuration an `Idempotency-Key` deduplicates only within that process, so a client retry that reaches a restarted server could start a duplicate run and repeat its effects.

`submissionJournal` closes that gap. `createAggregateSubmissionJournal(store)` (exported by `@mayura/storage`) atomically claims each owner-scoped key with the request digest before any run starts. Within one process the existing run is returned as before, and concurrent equivalent requests share one claim. After a restart, a retry with the same key and payload receives `409 SUBMISSION_OUTCOME_UNKNOWN` — the earlier run's outcome is not knowable from the new process, so neither a replay nor a new run would be truthful — and a changed payload receives `409 IDEMPOTENCY_CONFLICT`. If the journal cannot confirm a claim the server answers `503 SUBMISSION_JOURNAL_UNAVAILABLE` and starts nothing. Claims are permanent and store only digests. Work that must survive restarts should run as a durable workflow (for example through `agentAsDurableWorkflow`), not as an ephemeral HTTP run.
