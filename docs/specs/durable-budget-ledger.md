# Transactional durable budget ledger

Status: implemented and locally verified prerequisite for M2/V12; not durable child execution or enterprise qualification. This slice preserves the shared-ceiling accounting model of core `Budget`, without silently changing existing scheduled runtimes. Its evidence belongs in the [development ledger](../development-status.md).

## Boundary and sequence

Existing format-2/3 workflows account only for their own jobs, use one policy per driver and acquire member aggregate locks before job/resource locks. External waits require existing same-policy targets and do not own them. None can safely gain child ownership through an added reference or an independently updated budget table.

First implement a reusable financial/call ledger through the optional `.durableBudgets` capability in the selected SQL adapters and driver-free storage contracts. It calls no model, tool, handler or approval callback. It does not authenticate callers, narrow grants, create execution runs or prove an external outcome. Root `policyHash` and account identities are immutable correlation pins, not capabilities. Trusted hosts own all input evidence and access control. Existing core budgets and scheduled profiles are unchanged and are NOT automatically protected by this ledger.

Next, a separate new child-capable workflow profile must atomically bind ledger accounts, narrowed policies, immutable ownership links and child creation; enforce root-first locking on every prepare/start/receipt/cancel path; and require successful child joins before parent success. No adopted legacy runs or execution placeholders are introduced by this prerequisite. Future scheduler-owned ledgers must have a distinct owner tag and reject standalone host mutations.

## Public storage contract

Export `DurableBudgetStore`, `DurableBudgetAggregateStore`, `DurableBudgetKey`, `DurableBudgetSnapshot`, `DurableBudgetAccount`, `DurableBudgetReservation`, `DurableBudgetBundle`, command/result types and strict codecs from `mayura/storage-contracts`. Both selected factories return their existing graph/discovery capabilities intersected with `DurableBudgetAggregateStore`; custom adapters gain no mandatory methods.

Every key contains `{ scope, id, policyHash }`; scope/id are nonempty well-formed Unicode strings of at most 256 UTF-8 bytes without NUL, and policyHash is a lowercase 64-character hexadecimal digest. Reject unpaired UTF-16 surrogates before transport; never replace or normalize identity text. Account, bundle and reservation IDs use 1–128 ASCII letters/digits plus internal `.`, `_`, `:`, `/`, `-`; `root` is the reserved root-account ID. Limits are nonnegative safe-integer `maxCostMicros` and positive safe-integer `maxCalls`.

| Method | Exact command and result |
| --- | --- |
| `initialize()` | Explicit capability setup after application store initialization; returns undefined. |
| `create(key + limits)` | Creates immutable root configuration; returns `{ snapshot, created }`. Exact retry returns current snapshot and `created: false`; changed content conflicts. |
| `fork(key + { parentId, accountId, maxCostMicros, maxCalls })` | Adds one child ceiling, returns snapshot. Exact existing identity/content is a no-op; reparenting or different limits conflict. |
| `reserveBundle(key + { accountId, bundleId, operations: [{ id, maxCostMicros }] })` | Atomically holds every operation's funds and future call on the account and each ancestor. Returns snapshot. Exact bundle retry is a no-op even after later transitions; mixed/reused reservation IDs or changed bundle content conflict. |
| `start(key + { accountId, reservationId })` | Returns `{ snapshot, status: 'started' \| 'already_started' }`. Only the first held→started transition consumes a call. Historical started/unknown/settled tickets return already_started, never a new permission to execute. Cancelled tickets conflict. |
| `markUnknown(key + { accountId, reservationId })` | Started→unknown; retains all reserved funds and consumed calls. Same unknown is a no-op; later unknown cannot erase settled truth. Held/cancelled conflict. Returns snapshot. |
| `settle(key + { accountId, reservationId, actualMicros })` | Started/unknown→settled with one exact nonnegative safe-integer known cost; releases its bound and charges full actual usage. Returns `{ snapshot, overrun }`, including a committed overrun; never throw an overrun inside the transaction. Exact known retry is a no-op; contradictory amounts conflict. |
| `cancelReservation(key + { accountId, reservationId })` | Releases only held funds/call slots; cancelled retry is a no-op. Started/unknown/settled conflict. Returns snapshot. |
| `closeSubtree(key + { accountId })` | Sticky local account closure plus cancellation of all held reservations in its bounded subtree in the same transaction. Preserves siblings, historical calls and started/unknown funds. Returns snapshot; repeat is a no-op. |
| `inspect(key)` | Frozen full financial snapshot or undefined for an absent root; wrong policy on an existing root conflicts. |
| `events(key + { after? })` | At most 1,000 ordered metadata-only `StoredEvent` values after the exclusive nonnegative sequence; default zero. |

No caller-submitted replacement state, deltas, timestamps, arbitrary SQL or transaction callback is public. Mutations of a missing root/account/reservation return `NOT_FOUND`; exact identity/content mismatch, forbidden transition, closure or blocked admission returns `CONFLICT`; configured money/call or structural limits return `LIMIT_EXCEEDED`; malformed input returns `INVALID_INPUT`; corrupt persisted or malformed transport data returns `STORAGE_UNAVAILABLE`. Error messages contain no driver details or financial payloads.

## Accounting and immutable evidence

Mode is exactly `shared-ceiling-v1`; persisted format is 1 and owner is exactly `host-v1`. A fork does not reserve funds or promise prepaid capacity. Child ceilings cannot exceed their immediate parent's ceilings. All siblings compete for the SAME ancestor balance. Reservations, not the sum of child ceilings, partition funds. Ancestor usage includes descendants and must not be summed with their snapshots.

A held reservation charges its bound to `reservedMicros` and one `heldCalls` along its exact root-to-owner path. Start converts heldCalls to historical `calls`, preserving funds. Known settlement releases only that bound and adds actual cost to spent. Unknown status retains the complete bound indefinitely; no timeout, close, restart or retry proves zero usage. This slice provides no post-start refund or external reconciliation shortcut.

If actual exceeds the ticket bound, commit the full cost, set root-wide sticky `blocked`, and reject new forks/reservations/starts throughout the tree. Existing unknown/started reservations still accept truthful late settlement, and held reservations remain explicitly releasable. Individual costs are safe integers; cumulative spent is computed with BigInt and serialized as a safe JSON number or canonical positive decimal string. Never clamp or round an overrun. Calls remain consumed after settlement, including zero cost.

Corruption validation also rederives nominal settled spending as `sum(min(actualMicros, maxCostMicros))` plus current holds on every ancestor. That amount must still fit the original ceiling, even when actual spending includes an overrun. This is a necessary historical-admission invariant, not a replacement for full actual accounting or proof of the order of every past event.

`closeSubtree` intentionally combines account closure and held-ticket cleanup. Core `Budget.close()` alone only closes admission; this durable convenience operation is stronger and named explicitly. Descendants are effectively closed by ancestry; no reopening, deletion, ID recycling or account adoption exists. A closed/blocked ledger still permits inspection, evidence, known settlement and held cleanup. Exact historical creation/bundle retries may return their current state but never create new authority.

Snapshots are detached/frozen financial metadata: identity, fixed mode/owner/format, version/event sequence, blocked flag, ordered accounts, bundles and reservations. Accounts expose immutable parent/ceilings/closure plus derived spent/reserved/calls/heldCalls. Reservations retain exact bundle/owner/cost identity, status and actualMicros (null until known). Validate ancestry, ceilings, unique lifetime IDs, bundle/reservation one-to-one content, status/actual consistency and all derived counters. Historical bundles must still fit their original ancestor limits after held capacity is released. Versions must fall within the possible event-count range implied by retained accounts, bundles, closures and ticket transitions; an inflated counter cannot consume terminal headroom. Never trust a caller or stored counter delta. Account IDs identify no runnable agent and the snapshot contains no prompts, outputs, credentials or receipts.

## Persistence, bounds and recovery

Use one separately owned `mayura_durable_budgets` root row keyed by `(scope, id)` with checked policy/mode/owner/version/event-sequence projections and bounded canonical state. Record metadata-only events in `mayura_durable_budget_events` with `(scope, budget_id, sequence)` primary key and root foreign key. Read and mutate under one root identity mutex before any row mutation. PostgreSQL uses a transaction-scoped advisory identity lock plus row locking; SQLite uses its existing serialized `BEGIN IMMEDIATE` transaction. Keep all transactions finite and free of external calls. Independent roots share no money or tree mutex; PostgreSQL hash collisions may conservatively serialize unrelated roots without sharing authority.

One successful semantic mutation adds exactly one version and one event; exact retries and no-ops add neither. Root creation and its first event commit together. Use stable root/account/bundle/reservation identities for semantic dedup, not an unbounded retry journal. Changed content never overwrites an earlier admission. Command values are snapshotted before asynchronous initialization/IPC; transport replies are independently validated against their method/key/identity.

Bounds: 128 lifetime accounts including root, depth 16 (root zero), 128 lifetime bundles, 512 lifetime reservations, 1–32 operations per bundle, 1 MiB state/snapshot, and 2,048 lifetime events. Fixed identity retention bounds allow the full close/unknown/settlement suffix after all admissions; no generic command history or user payload may consume that reserved evidence capacity. Each reservation can start, become unknown and settle at most once, or be cancelled before start. A subtree close summarizes cancelled held tickets in one event. Invalid or rejected admission burns no identity, event or capacity. Capacity is not silently raised to pass tests.

The shared SQL implementation exposes an INTERNAL same-session seam for later atomic execution integration; no new engine or nested transaction is copied per adapter. That seam is trusted host plumbing, not authority for an agent. This standalone profile does not provide effect leases/fences, automatic recovery execution or exactly-once external actions. In particular, uncertain start acknowledgement requires reconciliation; `already_started` must never be treated as a dispatch grant.

Locking decisions follow [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) and [SQLite transactions](https://www.sqlite.org/lang_transaction.html): one consistent root-first boundary, short database-only transactions and no row-lock concurrency claim for SQLite. These references establish database mechanics, not production throughput or security certification.

## Failure-first acceptance

- Exact strict codecs and public types; missing/extra/accessor/malformed fields, unsafe integers and decimal totals, wrong mode/owner, cycles/reparenting, mutated input, cross-root/policy/account confusion and fabricated transport counters.
- Root/fork/bundle idempotency and conflict races; concurrent siblings cannot exceed root money/calls; intermediate ancestors constrain descendants; zero-cost calls still count; multi-operation admission is all-or-nothing.
- First versus repeated start, lost start acknowledgement, explicit unknown retention, conflicting known evidence, late known cost after close and overrun, exact above-safe-integer cumulative spending, no terminal-capacity starvation.
- Subtree close races with reserve/start/fork; siblings remain open; started work is never refunded; held cleanup and historical retries do not restore authority. Repeated no-ops do not grow history.
- Real SQLite/PostgreSQL close/reopen, competing connections, durable row/event atomicity, same-session rollback, corruption detection and actual owned-process termination at reserve/start/settlement commit boundaries.
- Driver-free packed declarations/custom-adapter boundary plus actual selected-storage archives and a credential-free finite example; unchanged base SDK dependency and size budgets.

No new external dependency, paid provider call, remote publication or license decision is required. Every enterprise release gate remains open until independently qualified.
