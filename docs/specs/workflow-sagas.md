# Durable workflow sagas

Status: format-1 authoring, strict state codec, SQLite/PostgreSQL runtime and packed custom-adapter surface implemented.

`mayura/workflows/sagas` composes format-5 lifecycle workflows into a finite sequential saga. It is a separate persistence format and digest domain; formats 2–5 remain unchanged.

## Contract

A saga declares 1–128 ordered steps. Each step has one forward lifecycle and may have one compensation lifecycle. Forward input bindings may reference the submission input or earlier successful step output. Compensation input may additionally reference its own forward output. All definitions are branded executable objects, while persisted manifests contain only child definition hashes, static cost/call bounds and data-only bindings.

The authoring layer calculates the worst-case forward-plus-compensation cost and call count. Submission is rejected when that cost exceeds the runtime ceiling. Actual cost is projected from durable child receipts and cannot exceed the persisted saga ceiling.

## Execution and recovery

Forward children run in declaration order. A terminal child failure skips later forward steps and compensates earlier successful steps in reverse order. Invalid final-result material also enters reverse compensation. A compensation failure stops the saga with `compensation_failed`; it is never reported as successfully compensated.

Every child submission uses a deterministic key derived from the saga run, step and phase. This repairs the deliberate crash boundary between creating a child aggregate and persisting its link in the saga aggregate. Reopening a conforming SQLite, PostgreSQL or custom aggregate adapter therefore converges on the same child rather than duplicating it.

The generic `AggregateStore` cannot atomically write two aggregates. Stable replay identities close the duplication window, but they are not a distributed transaction: an operator must preserve both records and investigate unresolved child effects using lifecycle reconciliation evidence. A host invokes `runUntilSettled`; the runtime starts no poller or background worker.

Human requests, approvals and timers remain owned by the linked format-5 child. The saga runtime exposes its lifecycle runtime so an authenticated host can route those interactions. Saga cancellation first cancels the active child and then persists the saga cancellation intent.

## Security boundaries

- Persisted definitions, state, identities, accounting and bindings use strict codecs and finite bounds.
- Runtime scope, policy and definition hashes must exactly match on every continuation.
- Schema callbacks have timeouts and retained-callback admission; timed-out noncooperative callbacks continue consuming capacity until they settle.
- Storage failures are retryable and are not converted into business failures. Only deterministic input/output rejection can create an admission-failure transition.
- The runtime installs no SQL driver and accepts only the public aggregate-store interface.
