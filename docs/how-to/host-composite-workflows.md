# Host saga and loop parents

Use the composite host for durable saga and loop submissions that must continue after process restart:

```ts
const host = createWorkflowCompositeHost({
  store, scope, permissions, policyVersion: '2026-09', maxCostMicros: 100_000,
  sagaDefinitions: [orderSaga], loopDefinitions: [pollLoop],
  intervalMs: 1_000, maxBackoffMs: 30_000,
});

await host.runtime.submitSaga(orderSaga, { input, idempotencyKey: orderId });
host.start();
// graceful shutdown
await host.close();
```

Submit through `host.runtime.submitSaga` or `submitLoop` so the parent index is recorded. If an acknowledgement is uncertain, retry with the same key to repair indexing. Use the owned saga/loop lifecycle runtime for human responses and approvals. Provide external leader election before running multiple hosts for one scope.
