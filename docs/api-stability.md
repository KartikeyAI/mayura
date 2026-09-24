# Public API stability and upgrade policy

Mayura `0.1.0-dev.0` is a development preview. It has no stable entry points. Every exported workspace entry point is explicitly experimental; `@mayura/consumer-tests` is internal and is never a distribution entry point. The machine-readable classification is `compatibility/api-stability.json`, and the package `exports` maps are the exact supported import paths. Deep imports are unsupported.

Experimental means the current revision is documented and tested but may change incompatibly before 1.0. A changelog and migration note are required for an intentional incompatible change. Development previews receive best-effort support only; a stable support window, deprecation period and long-term maintenance promise must be approved before 1.0. This prevents development-preview APIs from acquiring an accidental enterprise support claim.

Persisted formats are separately versioned from package SemVer. A current runtime must refuse an unknown format. Migration is explicit, one-way, reviewed and tested; opening a store never silently applies an incompatible migration. `migrateSqliteStoreV0ToV1` is the first recorded prior-version fixture. It requires an existing persistent v0 file, validates integrity plus the exact v0 layout, migrates transactionally, preserves aggregate/event data, and refuses a second or ambiguous migration. Operators must retain and verify a backup before invoking it.

Consumer type/runtime checks, exact package export checks, adapter conformance suites and the prior-version migration fixture form V21 evidence. They do not create stable APIs or expand the development-preview support terms in `SUPPORT.md`.
