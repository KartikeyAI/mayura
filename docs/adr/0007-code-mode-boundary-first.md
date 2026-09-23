# ADR 0007: Code Mode boundary before sandbox selection

Status: accepted for the experimental foundation.

## Context

Code Mode must orchestrate ordinary Mayura tools without granting generated source ambient host authority. No candidate interpreter or OS-isolation profile has yet passed Mayura's containment, packaging and recovery gates. Selecting one prematurely would either pull a native sandbox into the base SDK or imply security guarantees that current evidence does not establish.

## Decision

Create optional `@mayura/code-mode` with only content-addressed program artifacts, immutable resource manifests, a replaceable sandbox-adapter contract and a bounded nested-tool bridge. The package depends only on `@mayura/core`, `@mayura/tools` and Node built-ins. It never evaluates source and never falls back to host execution.

Every nested request resolves a tool from the program's pinned genuine catalog and re-enters a caller-supplied trusted broker. Code Mode supplies stable program/execution/call identities, cancellation and limits; it does not accept credentials, budgets, approval issuers or arbitrary clients. Unqualified test adapters require an explicit opt-in and confer no containment claim.

## Consequences

Developers can integrate and test program provenance and broker equivalence without installing a sandbox binary. This is not usable hostile-code containment, does not close V15 and does not select `isolated-vm`, QuickJS or an outer worker technology. The first production adapter requires a separate ADR plus OS-enforced escape, quota, packaging, crash and replay evidence.
