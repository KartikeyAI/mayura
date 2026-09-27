# Run a compensating workflow saga

Import `defineWorkflowSaga` and `createWorkflowSagaRuntime` from `mayura/workflows/sagas`. Define each forward action and compensation as a format-5 lifecycle, then bind steps using submission input or earlier outputs.

```ts
const order = defineWorkflowSaga({
  id: 'order', version: '1', input: orderInput, output: orderOutput,
  steps: [
    { id: 'reserve', forward: reserveInventory, input: { kind: 'input', path: [] },
      compensation: { workflow: releaseInventory,
        input: { kind: 'step', stepId: 'reserve', path: [] } } },
    { id: 'charge', forward: chargePayment,
      input: { kind: 'step', stepId: 'reserve', path: [] } },
  ],
  result: { kind: 'step', stepId: 'charge', path: [] },
});

const runtime = createWorkflowSagaRuntime({ store, scope, permissions,
  policyVersion: '2026-09', maxCostMicros: 50_000 });
const run = await runtime.submit(order, { input, idempotencyKey: orderId });
const current = await runtime.runUntilSettled(order, run.id);
```

Call `runUntilSettled` again after a linked child receives a human response, approval, or reaches its absolute wake time. Keep the submission key stable across uncertain acknowledgements. Treat `compensation_failed` as an operator incident; do not claim rollback succeeded.
