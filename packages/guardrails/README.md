# @mayura/guardrails

Experimental content processors and required guard barriers. Native helpers provide user-envelope normalization, configurable heuristic PII redaction, protected-literal matching, bounded independently admitted output batches, and a fail-closed whole-output buffer for cross-chunk checks.

`prepareOutputDisclosure` converts bounded structured output into one content-only candidate: tool previews and raw events are withheld, error messages are dropped in favor of stable codes, and citations require an exact configured HTTPS origin with no credentials/query/fragment. The resulting candidate still passes through the supplied required pipeline before release.

`createAuxiliaryCheck` adds one schema-validated auxiliary model call using an explicitly supplied genuine shared Budget and exact model permission. `detectAndTranslate` preserves source-mapped protected segments locally and meters separate detection/translation calls. `createModerationGuard` supplies a typed model verdict without converting unavailable checks into approval.

`defineModerationGuard` is the separate definition-only API for runtime-owned input/output moderation. Pass its immutable handle to an ephemeral agent's guards; the runtime supplies the actual shared account, ancestor counters and operation permits. Required output-check capacity is protected before a prospective model/tool dispatch. An explicit local `egressGuards` list is required; an empty list offers no local screening guarantee.

Only core is a runtime dependency. There are no hidden providers, credentials, retries, paid calls or new ledgers. Model moderation and translation remain fallible; local detectors are not complete privacy or injection defenses. Durable runtime integration is not implemented.

See [managed moderation](../../docs/how-to/managed-guardrails.md), [native processors](../../docs/specs/processors.md) and [caller-wired auxiliary helpers](../../docs/specs/auxiliary-guardrails.md) for admission, evidence, cancellation, retention and integration limitations.
