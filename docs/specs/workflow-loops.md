# Durable bounded workflow loops

Status: format-1 authoring, strict state codec, SQLite/PostgreSQL runtime and driver-free public subpath implemented.

`@mayura/workflows/loops` repeats one format-5 lifecycle body under an explicit maximum of 1–1,024 iterations. It is a separate persistence and digest boundary; it does not alter existing workflow or saga formats.

The definition declares four data-only bindings: the first child input, subsequent child input, a boolean continuation value, and the final result. Bindings can read immutable submission input or the latest successful child output. No expression text, callback, timer handle or unbounded condition is persisted.

Worst-case cost and call count equal the body bounds multiplied by `maxIterations`; unsafe arithmetic and runtime ceilings below that bound are rejected before effects. Each iteration child has a deterministic run identity. A crash between child creation and parent linking therefore converges on the same child after restart rather than submitting another one.

`runUntilSettled` returns when the loop succeeds, its child waits or fails, cancellation is persisted, or the finite limit is reached. A true condition at the limit produces `limit_exceeded`, never another iteration. Human requests, approvals and timers are served through the exposed lifecycle runtime. The runtime launches no background worker and the generic aggregate interface does not make parent/child writes transactional.
