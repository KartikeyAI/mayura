# Operational recovery matrix

Status: V17-qualified for the documented local/ephemeral profiles. These outcomes are explicit and bounded; they do not claim physical power-loss qualification, managed backup scheduling, or a distributed control plane.

| Failure | Required outcome | Executable evidence |
| --- | --- | --- |
| Disk full | Artifact stage/commit/restore fails closed, removes partial temporary data where possible, publishes no incomplete object, and remains retryable with the same content identity. | `packages/artifacts/test/disk-full.test.ts` |
| Provider outage | The run terminates with sanitized `MODEL_FAILED`; no provider exception text is released and no command is automatically replayed. Confirmed usage remains accounted where reported. | `packages/runtime/test/runtime.test.ts` |
| Corrupt cache/checkpoint | Mayura has no implicit context or credential cache. Invalid persisted memory/context/transport data is rejected without repair or disclosure; applications discard the bad checkpoint and rebuild from authoritative scoped sources. | `packages/memory/test/sqlite.test.ts`, `packages/context/test/context.test.ts`, `packages/client/test/client.test.ts` |
| Missing/corrupt artifact | Reads do not fabricate content. Bounded no-content audit reports missing/corrupt identity; integrity mismatch fails with `INTEGRITY_VIOLATION`. Reconciliation requires a fresh reviewed retained-set plan. | `packages/artifacts/test/artifacts.test.ts` |
| Migration/restore | Restore is an explicit application operation over a scope-pinned, integrity-bound, bounded backup. It is idempotent, refuses unrelated destination objects, and resumes an exact partial restore after process death. No package upgrade silently rewrites application data. | `packages/artifacts/test/artifacts.test.ts`, `packages/artifacts/test/restore-process-recovery.test.ts` |
| Exporter failure | Export failure/timeout/cancellation is sanitized and accounted as dropped/failed telemetry; it does not rewrite run truth. No construction-time or fallback destination is used. | `packages/exporter-otlp/test/exporter.test.ts` |
| Worker drain | Close rejects new admissions, aborts owned observations/work, retains admitted-handler capacity until actual settlement, and bounds half-open socket shutdown by the configured grace period. Late output remains withheld. | `packages/server-node/test/host.test.ts`, workflow coordinator/runtime close fixtures |

Operators must retain authorized diagnostics separately from public errors. An unknown external effect is reconciled from receipt/provider evidence, never converted into a retryable failure merely because a worker or provider connection disappeared. Backups and migration plans are application-owned privileged operations and require normal scope authorization, integrity verification, capacity limits and tested rollback/runbooks.
