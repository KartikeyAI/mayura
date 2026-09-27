# Use the bounded helper battery

`mayura/helpers` contains optional application-level utilities. It has no network, filesystem, model, tool or secret-store authority. Install it beside `mayura/core` and pass every source, sink, signal and budget explicitly.

## Safety rules

- Use `secretReference` for a credential handle; resolve the value only inside an authorized adapter.
- Use `validatedEnvironment` with an explicit source and allowlisted mapping. It never reads ambient process state.
- Set retry `safety` to `idempotent` or `read-only` only when that guarantee is true. Multi-attempt effects are otherwise rejected.
- Treat an `outcome_unknown` concurrency result as potentially executed. Mayura retains its complete monetary reservation.
- Use `transferArtifact` with a staging sink. Promotion happens only after the size and SHA-256 checks pass; every failure discards the stage.
- Allowlist log fields and mark sensitive allowed fields for replacement. Unknown fields are omitted.

## Budgeted concurrency

`runBudgetedTasks` admits the entire 1–128 task set through one genuine `Budget.reserveBundle` before any callback runs. It executes at most 64 callbacks concurrently, preserves result order, cancels undispatched tickets and settles known usage. A thrown callback or invalid usage report becomes `outcome_unknown` and retains the full declared bound.

These helpers coordinate trusted application callbacks; they are not a sandbox. Use Mayura tools, guardrails, Code Mode or an isolated worker when code is not trusted.
