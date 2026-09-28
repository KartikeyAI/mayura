# mayura/context

Experimental, dependency-light native context selection. Assemble scoped current-source evidence within explicit byte/token-estimate budgets while preserving required constraints, pending approvals, blockers, and outstanding tasks.

Exports `assembleContext` and `byteTokenEstimator`, with typed candidate, provenance, source-state, budget, and result contracts. Requires only `mayura/core`; no memory service, embedding provider, model, database, or cache is needed.

Optional validity intervals are evaluated at one explicit or snapshotted `asOf` timestamp. Preserve native-memory validity and original source identity under `provenance.upstream`; canonical memory record ID/version remain separate context source metadata. Use an explicit `asOf` when reproducible assembly fingerprints are needed.

See [Memory and context](../../docs/guides/memory-and-context.md). This package does not perform semantic retrieval or generated summarization and does not replace the final provider-token admission check.
