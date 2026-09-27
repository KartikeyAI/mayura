# Code Mode containment and broker contract

Status: experimental foundation; optional adapters are test-qualified, not hostile-code production-qualified.

## Boundary

`mayura/code-mode` describes content-addressed JavaScript or TypeScript programs and executes them only through an explicitly supplied sandbox adapter. It never evaluates source in the Mayura process and has no host fallback. An unavailable adapter produces `UNSUPPORTED_PROFILE` before source execution.

A sandbox adapter is trusted host integration code, not the security boundary by itself. A production profile must additionally prove an out-of-process, OS-enforced boundary with no ambient filesystem, process, credential, environment or network access; finite CPU, wall-clock, memory, scratch and output limits; deterministic termination; and authenticated IPC. Node `vm`, worker threads, TypeScript checks, source scanning and an interpreter isolate alone do not satisfy that claim.

## Program artifact

`defineCodeProgram` snapshots and validates:

- a bounded stable identifier, version, intent and source;
- `javascript` or `typescript` language;
- input and output Standard Schema validators;
- a unique finite catalog of genuine Mayura tool definitions;
- explicit finite resource limits; and
- approved import specifiers. The foundation defaults this list to empty and does not resolve imports.

The immutable manifest contains no callable executor. Its SHA-256 digest covers a canonical manifest and exact UTF-8 source. Program handles are instance-authenticated; a copied manifest cannot be executed as a definition.

## Execution

`createCodeMode` receives exactly one registered sandbox adapter and one trusted `invokeTool` function. Execution snapshots the input before the first asynchronous boundary, checks it against the program input schema, and gives the adapter only plain frozen data, program metadata, source, the effective abort signal and a restricted tool bridge.

The bridge exposes only `call(toolId, input)`. It:

1. rejects tools outside the pinned catalog;
2. allocates a host-controlled call ID bound to the program execution;
3. enforces total and concurrent call limits before invoking host code;
4. snapshots bounded plain JSON;
5. invokes the trusted host broker callback; and
6. returns a sanitized, immutable Mayura outcome.

The callback must route through the same policy, approval, budget, resource, guard, receipt and cancellation boundary as an ordinary tool invocation. The Code Mode package does not accept an approval callback, budget account, credentials, arbitrary SDK client or dynamic tool object. Parallel calls do not create additional authority.

The adapter result is admitted only after bounded JSON copying and output-schema validation. Adapter exceptions and invalid results are replaced with fixed public errors. A host deadline closes the bridge immediately. Code Mode waits for already-admitted nested calls to settle before returning, so their broker receipts and budget settlement are not abandoned; no new nested calls are admitted after cancellation.

Every result contains immutable host-derived usage: admitted nested calls, known fixed tool cost, unresolved cost and the program maximum. A succeeded/failed receipt settles its registered fixed cost, `not_started` settles zero, and an unknown or missing receipt retains that tool's cost as unresolved. Any unresolved cost forces the outer Code Mode result to `outcome_unknown`, even when generated code ignores a failed nested call and returns a valid-looking output. Program admission rejects a maximum cost that cannot be represented exactly as a safe integer.

## Host execution and durable recovery

This package does not execute generated source on the host. Host execution must be represented by a separate effectful tool and therefore requires the ordinary exact-action approval grant for the program digest, dependency digest and action. Renaming or persisting a generated program grants nothing.

The optional durable bridge records a digest-bound phase, exact approval and immutable nested-receipt audit around this ephemeral executor. Recovery reuses known results and never reruns a completed write. Unknown nested effects remain unknown until an authoritative external reconciler resolves them. Arbitrary heaps, closures and pending promises are never checkpointed.

## Qualification still required for V15

- independently evaluate container/kernel escape resistance and daemon/rootless hardening;
- qualify the pinned outer profile across supported hosts and architectures;
- add authoritative reconciliation for unknown external effects and atomically settle the durable outer ledger from recorded nested usage;
- qualify generated-tool promotion and host execution approvals beyond durable phase approval; and
- pass packed-consumer and supported OS/architecture installation matrices.

Until those items pass, Code Mode remains experimental and V15 remains open.
