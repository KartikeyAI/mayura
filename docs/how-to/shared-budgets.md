# Shared budgets and reserved follow-up capacity

This advanced primitive is for framework/runtime and adapter authors. It does not configure agent moderation by itself. Ordinary agent applications select explicit runtime limits and use the [managed moderation API](managed-guardrails.md); they do not manufacture runtime accounts or tickets.

## Shared accounts are ceilings, not extra credit

`Budget.fork` creates a child ceiling over the same ancestor funds and call limits. A child does not receive a separate prepaid balance. Root snapshots already include descendant charges, so summing them with child snapshots double-counts usage.

`reserve(maxCostMicros)` preserves its existing behavior: reserve money and consume one call immediately. `settle(actualCostMicros)` records confirmed usage once. Unknown usage remains reserved; reporting zero is not a cancellation mechanism.

## Reserve a bounded operation and its mandatory follow-up together

An atomic bundle protects both money and future call slots before any operation begins. Competing children and ordinary reservations cannot take that capacity.

```ts
import { Budget } from 'mayura';

const account = new Budget(10, 3);
const bundle = account.reserveBundle([
  { id: 'request-1/generate', maxCostMicros: 6 },
  { id: 'request-1/check', maxCostMicros: 2 },
]);

account.snapshot();         // { spentMicros: 0, reservedMicros: 8, calls: 0 }
account.capacitySnapshot(); // { heldCalls: 2 }

try {
  // Complete permissions, data-policy, cancellation and executor admission first.
  const generation = bundle.tickets[0]!.start();
  generation.settle(5); // Only an independently confirmed actual charge.

  const check = bundle.tickets[1]!.start();
  check.settle(1);
} finally {
  bundle.close(); // Releases only tickets that never started.
}
```

The example demonstrates accounting transitions, not real model calls or privacy screening. A runtime must additionally bind tickets to the exact run, operation, adapter and candidate and enforce separate model/tool counters and execution permits. A financial ticket never grants a tool permission or human approval.

## Ticket lifecycle

| Operation | Accounting behavior |
| --- | --- |
| Create bundle | Atomically hold total cost and call slots on every ancestor; failure changes nothing. |
| `ticket.start()` | Convert one held call into one consumed call; money remains reserved. Only one start is allowed. |
| `ticket.cancel()` | Release a never-started ticket's cost and held call. Repeating cancellation is harmless. Started tickets cannot be cancelled. |
| `reservation.settle(actual)` | Record confirmed cost once, retaining the consumed call even when cost is zero. |
| `bundle.close()` | Cancel remaining held tickets; leave started/unknown reservations intact. Repeated close is harmless. |

Frozen objects and private registrations make copied, proxied or serialized ticket/bundle shapes invalid authority. Keep genuine handles private to the trusted dispatcher. This is not isolation from malicious application JavaScript.

Account closure prevents ticket starts but still permits cancellation of held tickets and settlement of already-started reservations. Runtime terminal paths must explicitly close their bundles. A provider overrun records the full exact amount and blocks further ledger admissions, including held-ticket starts. Closing a bundle never forgives unknown cost. Very large aggregate overruns retain exact decimal-string reporting in `snapshot().spentMicros`.

## Finite limits and compatibility

Each bundle supports 1–128 operations. The shared ledger supports at most 1,024 outstanding held/started-unsettled bundle tickets and 16,384 lifetime ticket identities. Cancelled/settled identities cannot be reused. IDs use bounded ASCII letters, digits and `._:/-`, begin with a letter/digit, and are at most 256 characters. Limits reject before mutation; no history is silently evicted. Existing unnamed `reserve()` handles keep their established limits and behavior.

`snapshot()` keeps its original shape and consumed-call semantics. Held bundle money is part of `reservedMicros`; `capacitySnapshot().heldCalls` separately reports future calls, including descendants. A child fork never duplicates either capacity.

These are synchronous process-local accounting primitives. The ephemeral runtime now supplies its own kind-specific holds and managed moderation binding. Durable reservations, hook-triggered operations and production qualification require separate integration. See the [managed-guardrail contract](../specs/runtime-managed-guardrails.md).
