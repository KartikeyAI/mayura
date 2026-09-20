# @mayura/guardrails

Experimental content processors and required guard barriers. Native helpers provide user-envelope normalization, configurable heuristic PII redaction, protected-literal matching, and bounded admitted output batches.

`createAuxiliaryCheck` adds one schema-validated auxiliary model call using an explicitly supplied genuine shared Budget and exact model permission. `detectAndTranslate` preserves source-mapped protected segments locally and meters separate detection/translation calls. `createModerationGuard` supplies a typed model verdict without converting unavailable checks into approval.

Only core is a runtime dependency. There are no hidden providers, credentials, retries, paid calls, new ledgers, or automatic runtime integrations. Model moderation and translation remain fallible; local detectors are not complete privacy or injection defenses.

See [native processors](../../docs/specs/processors.md) and [auxiliary guardrails](../../docs/specs/auxiliary-guardrails.md) for admission, evidence, cancellation, retention, and integration limitations.
