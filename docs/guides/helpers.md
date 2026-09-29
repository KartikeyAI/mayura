---
title: "Helpers"
description: "Small utilities for configuration, secrets, retries, cancellation, pagination, redacted logging and budgeted concurrency."
---

`mayura/helpers` collects the small utilities most agent applications end up writing themselves: reading
configuration safely, handling credentials, retrying, deadlines, pagination, logging without leaking secrets, and
running tasks in parallel under a cost budget. None of them read the environment, the network or the filesystem on
their own. You pass every source, signal and sink explicitly, which keeps them easy to test.

```ts
import { retry, validatedEnvironment } from 'mayura/helpers';
import { z } from 'mayura';

const config = await validatedEnvironment({
  schema: z.object({ apiUrl: z.url(), timeoutMs: z.coerce.number().int().positive() }),
  source: process.env,
  fields: { apiUrl: 'ORDERS_API_URL', timeoutMs: 'ORDERS_TIMEOUT_MS' },
});

const orders = await retry(async (_attempt, signal) => {
  const response = await fetch(`${config.apiUrl}/orders`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}, { signal: AbortSignal.timeout(30_000), maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 2_000, safety: 'read-only' });
```

## Configuration

| Helper | Use it to |
| --- | --- |
| `validatedEnvironment({ schema, source, fields })` | Pick named variables from `source` (usually `process.env`), map them to your field names and validate them. Only the variables you list are read. An error names the failing variables, never their values. |
| `validatedConfig(schema, value)` | Validate any configuration object and return a frozen copy. Rejected values are not echoed in errors. |
| `providerSchema(schema, jsonSchema)` | Pair a runtime validator with the JSON Schema you send to a model provider, so neither is inferred from the other. |
| `capture(operation)` | Run an operation and get `{ ok: true, value }` or `{ ok: false, error }` with a safe public error instead of a thrown exception. |

Empty variables are rejected unless you pass `allowEmpty: true`. Each value is limited to 16 KiB, and a mapping can
list up to 128 variables.

## Secret references and the credential broker

Keep secrets out of configuration objects. A `secretReference({ provider, key, version })` is a frozen handle that
names a secret without containing it. The credential broker resolves a handle only for the duration of one callback:

```ts
import { createCredentialBroker, defineCredentialProvider, secretReference } from 'mayura/helpers';

const vault = defineCredentialProvider({
  id: 'vault',
  resolve: async ({ key }, signal) => {
    const value = await readSecretFromVault(key, signal);
    return { bytes: new TextEncoder().encode(value), version: '1' };
  },
});
const broker = createCredentialBroker({ providers: [vault] });

const apiKey = secretReference({ provider: 'vault', key: 'orders-api-key' });
const status = await broker.use(apiKey, AbortSignal.timeout(10_000), async credential => {
  const response = await fetch('https://orders.example.com/health', {
    headers: { authorization: `Bearer ${new TextDecoder().decode(credential)}` },
  });
  return response.status;
});
```

The broker copies the secret into a fresh buffer, passes it to your callback, and zeroes it afterwards. It never
caches. Resolution times out after 10 seconds by default (`timeoutMs`, up to 60 seconds), at most 16 uses run at once
(`maxConcurrent`), and secrets are limited to 64 KiB (`maxSecretBytes`). A provider can return `expiresAtMs`; expired
material is refused. If the callback throws, `use` rejects with `TOOL_FAILED` and no detail, so a secret cannot leak
through an error message.

## Retries

`retry(operation, options)` calls `operation(attempt, signal)` until it succeeds or the attempts run out, waiting
`initialDelayMs`, then multiplying by `backoffFactor` (default 2) up to `maxDelayMs`.

The required `safety` option is your statement about repeating the operation:

| `safety` | Meaning |
| --- | --- |
| `'read-only'` | The operation changes nothing. Safe to repeat. |
| `'idempotent'` | Repeating it has the same effect as doing it once, for example because it sends an idempotency key. |
| `'single-attempt'` | Must not be repeated. `maxAttempts` above 1 is rejected with `PERMISSION_DENIED`. |

Only claim `read-only` or `idempotent` when it is true: retrying a payment that is neither can charge twice. Other
options: `maxAttempts` (up to 10), `retryable(error, attempt)` to stop early on errors that will not go away, and an
`onRetry` hook that sees the attempt number, the next delay and the error code, and can return
`{ decision: 'block' }` to stop retrying.

## Cancellation and deadlines

| Helper | What it does |
| --- | --- |
| `withDeadline(operation, signal, timeoutMs)` | Runs `operation(childSignal)` and rejects with `TIMEOUT` or `CANCELLED` when the deadline passes or the parent signal aborts. A late result is discarded. |
| `deadlineSignal(signal, timeoutMs)` | A child signal that aborts at the deadline or with its parent. Call `dispose()` when done. |
| `delay(ms, signal)` | A sleep that rejects with `CANCELLED` when the signal aborts. |
| `pollUntil(read, accept, { signal, maxAttempts, intervalMs })` | Reads until `accept(value)` is true, then returns the value; rejects with `TIMEOUT` after `maxAttempts`. |
| `withCleanup(acquire, use, release)` | Runs `release` exactly once. A failing `release` never hides an error from `use`. |

JavaScript cannot stop a running function from outside. These helpers stop waiting and hand the abort signal to your
code; your code has to honour it.

## Pagination

`collectPages(fetchPage, { signal, maxPages, maxItems })` follows cursor pagination until a page has no `nextCursor`.
Each call to `fetchPage(cursor, signal)` returns `{ items, nextCursor }`. It stops with `LIMIT_EXCEEDED` when a limit is
reached and with `CONFLICT` when the API returns a cursor it has already seen, so a buggy API cannot loop forever.

```ts
import { collectPages } from 'mayura/helpers';

const tickets = await collectPages(async (cursor, signal) => {
  const response = await fetch(`https://tickets.example.com/list${cursor ? `?after=${cursor}` : ''}`, { signal });
  const body = await response.json() as { items: { id: string }[]; next?: string };
  return body.next ? { items: body.items, nextCursor: body.next } : { items: body.items };
}, { signal: AbortSignal.timeout(60_000), maxPages: 50, maxItems: 5_000 });
```

## Redacted logging

`createRedactedLogger(sink, { allowedFields, redactedFields })` writes structured JSON entries to your `sink`. Only
fields in `allowedFields` are kept; fields also listed in `redactedFields` are written as `[REDACTED]`. Anything else
is dropped, so a new field cannot start leaking by accident.

```ts
import { createRedactedLogger } from 'mayura/helpers';

const logger = createRedactedLogger(entry => { console.log(JSON.stringify(entry)); }, {
  allowedFields: ['orderId', 'status', 'customerEmail'],
  redactedFields: ['customerEmail'],
});
await logger.log('info', 'order.refunded', { orderId: 'ord-1001', status: 'ok', customerEmail: 'a@example.com', token: 'secret' });
// {"timestamp":1790000000000,"level":"info","event":"order.refunded","fields":{"orderId":"ord-1001","status":"ok","customerEmail":"[REDACTED]"}}
```

## Budgeted concurrency

`runBudgetedTasks(tasks, { budget, signal, concurrency })` runs up to 128 tasks, at most `concurrency` (up to 64) at a
time, under a `Budget` from `mayura`. Before any task starts, it reserves every task's `maxCostMicros` in one step; if
the budget cannot cover all of them, nothing runs. Each task returns `{ value, costMicros }`, and unused reservation is
released.

```ts
import { Budget } from 'mayura';
import { runBudgetedTasks } from 'mayura/helpers';

const budget = new Budget(50_000, 10);
const results = await runBudgetedTasks(['a', 'b', 'c'].map(topic => ({
  id: `summarize-${topic}`,
  maxCostMicros: 10_000,
  execute: async (signal: AbortSignal) => ({ value: await summarize(topic, signal), costMicros: 4_000 }),
})), { budget, signal: AbortSignal.timeout(60_000), concurrency: 2 });
```

Results keep the order of the tasks. A task that throws, or reports its cost incorrectly, comes back as
`outcome_unknown`: it may have done its work and spent money, so its whole reservation stays charged.

## Verified downloads

`transferArtifact(source, stage, { signal, expectedDigest, maxBytes })` copies an async stream of byte chunks into a
staging sink (`write`, `commit`, `discard`), checks the size limit (up to 64 MiB) and the expected `sha256:` digest,
and only then calls `commit`. On any failure it calls `discard`. See [artifacts](artifacts.md) for local file storage.

## Good to know

- The helpers coordinate your own trusted code. They are not a sandbox; for untrusted code use
  [Code Mode](code-mode.md).
- Errors are `MayuraError`s with stable codes such as `TIMEOUT`, `CANCELLED` and `LIMIT_EXCEEDED`, and messages that never
  include the values involved. See [outcomes](../concepts/outcomes.md).

## Related

- [Costs and budgets](../concepts/costs-and-budgets.md)
- [Lifecycle hooks](lifecycle-hooks.md)
- [Deployment](deployment.md)
- [Artifacts](artifacts.md)
