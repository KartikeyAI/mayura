# Ephemeral agent orchestration

Status: implemented experimental ephemeral runtime slice. This does not qualify durable orchestration.

## Public surface

`runtime.spawn(parentHandle, agent, { input, permissions, limits? })` creates a required child. The parent handle must be the exact live handle minted by the same runtime. `agentAsTool(agent, { id, description, permissions, limits?, inputJsonSchema? })` exposes the same child admission path through the ordinary tool broker. Neither operation creates a new root runtime or new budget. `runtime.inspect(handle)` returns bounded metadata, current accounting and execution evidence, including late known receipts; it never returns transcripts or provider continuation.

Child permissions are explicit, snapshotted, and intersected with parent grants. Both paths require `agent:delegate`; composition additionally requires its ordinary `tool:<id>` grant. Scope is inherited unchanged. A run identifier is not a capability. The private runtime gateway is attached to a broker-minted context using an opaque context slot, never looked up from a caller-supplied identifier. Standalone invocation cannot use this gateway.

## Lifecycle and scheduling

- Child admission and parent closure are synchronous state transitions. Once execution reaches its terminal candidate, further child admission closes. Already accepted children are joined before success can be published.
- All children are required. No detach, arbitrary cross-root waits, or implicit retry. An uncertain descendant effect forces `outcome_unknown`; otherwise a required-child failure prevents parent success. Parent cancellation reaches every descendant; cancelling a child does not independently cancel siblings.
- Each child has the earliest ancestor/child deadline. Cancellation is cooperative for trusted callbacks, not process isolation. Returned outcomes are immutable; late evidence can only update inspection/accounting.
- Root admission, total descendants (default 64, maximum 1,023), depth (default 8, maximum 32), and executable-operation concurrency are separate bounds. Waiting ancestors and composition wrappers do not hold an operation permit. Model and ordinary tool operations do; permits remain held until the trusted callback actually settles, including after cancellation. Queued admission is bounded by the run tree and abortable.
- Identity-based and repeated agent-ID ancestry are rejected, including aliases sharing an ID. Root-wide and intermediate model/tool counters prevent free-call amplification. Run-local step limits still apply.
- Application callbacks are trusted plugins. Calling direct `spawn` and then waiting inside an ordinary model/tool callback is not a supported nested-execution mechanism; use `agentAsTool`, whose wait is visible to the scheduler.

## Accounting and evidence

Child budget limits are ceilings over the shared ancestor ledger, not prepaid allocations. Every executable model/tool reservation is admitted synchronously against all ancestors. Settlement charges each account once; totals must not be summed across ancestors. Invalid/unknown usage retains the reservation; known overruns retain full exact cost and stop new ledger admissions. Closing an account never forgives unknown usage. The zero-cost composition wrapper counts as a tool attempt, but does not reserve the child's cost ceiling.

`Outcome.evidence` is optional bounded metadata containing `{ runId, receipt }` entries for composed run trees; a receipt's call ID is only unique within its run. Every child and its descendant effects remain identifiable. The legacy singular receipt remains the immediate failing tool's receipt, not a claim to summarize all effects. Successful parent output must not erase earlier effects. Inspection retains own receipts even for non-composed runs, preserving compatibility of their existing outcome shape.

The runtime snapshots child outcomes and aggregates receipts independently of the wrapper handler's return/throw. A child write followed by blocked disclosure cannot become an ordinary no-effect wrapper failure. Unknown evidence is not overwritten by stale cancellation, and late known completion cannot release late output. Inspection is process-local metadata, not a durable audit log.

## Schemas, privacy and extension boundary

The tool broker validates a composed tool's input using the child's input schema. Its private gateway receives that admitted value; the child does not feed transformed input through the original schema again. Child output is validated once by the child and passed through a JSON-only identity output boundary in the wrapper. Preflight may evaluate a pure schema on the original input again, as for ordinary tools; validators must be deterministic and side-effect-free.

Children receive only explicit input and their own configured instructions, tools and guards. They inherit authority ceilings, not conversation history, provider continuation, memory, credentials, or hidden system text. The parent model receives only admitted child output. Events and inspection expose bounded identifiers, status, accounting and receipts, never content.

Opaque tool context slots are trusted application extension plumbing, not a sandbox. A slot cannot be forged from its serialized shape, and only a holder of that slot can create/read its bindings. Runtime delegation uses a non-exported slot and rechecks live parent state and abort state at use.

## Required evidence

Direct/tool path equivalence; foreign/copied/terminal handle rejection; narrowed grants; shared root/intermediate money and free-call caps; exact overrun and retained unknown reservations; depth/cycle/descendant limits; structured joins; deadline/cancellation propagation; one-operation-slot nested progress; bounded abortable queues; transform parity; transcript isolation; mixed known/unknown child receipts; late settlement without disclosure or unhandled rejection; packed SDK type inference and composition example.

The bounded ephemeral profile plus the format-4 one-level durable profile jointly satisfy V05. Ephemeral fixtures prove finite ancestry, cycle/identity rejection, shared root/intermediate budgets, operation ceilings and one-slot nested progress. Format-4 fixtures prove recursive tree rejection, a fixed one-level child boundary, shared root/child ledger ceilings, waiting-parent progress and bounded shared execution capacity on SQLite and PostgreSQL. Dynamic durable agent descendants, deeper durable child links, distributed capacity and production-scale performance remain separate roadmap capabilities.
