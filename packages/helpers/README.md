# mayura/helpers

Optional, provider-neutral utilities for explicit configuration, cancellation-aware control flow, bounded data movement and safe diagnostics. These helpers carry no tool, model, storage or network authority and cannot bypass Mayura admission contracts.

## Included utilities

- schema-validated configuration and explicit environment selection;
- secret references that never contain credential values;
- a provider-neutral credential broker with use-scoped material, version/expiry checks, zeroing and retained callback admission;
- linked deadlines, cancellation-aware delays, bounded polling and cursor pagination;
- retries that require an idempotent or read-only guarantee;
- exactly-once cleanup with primary-error precedence;
- digest-verified staged artifact transfer;
- allowlisted, bounded and field-redacted structured logging;
- atomically admitted, budget-aware bounded concurrency.

All operations require explicit sources, sinks, signals and limits. The package reads no ambient environment, performs no network calls and opens no filesystem paths.
