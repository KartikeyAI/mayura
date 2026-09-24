# Run a durable bounded loop

Define the loop body as a format-5 lifecycle whose output contains the next input state and a boolean condition. Then create a bounded loop:

```ts
const poll = defineWorkflowLoop({
  id: 'poll-operation', version: '1', input: pollInput, output: resultSchema,
  body: pollOnce, maxIterations: 20,
  initial: { kind: 'input', path: [] },
  next: { kind: 'current', path: [] },
  continueWhen: { kind: 'current', path: ['pending'] },
  result: { kind: 'current', path: ['result'] },
});

const runtime = createWorkflowLoopRuntime({ store, scope, permissions,
  policyVersion: '2026-09', maxCostMicros: 100_000 });
const run = await runtime.submit(poll, { input, idempotencyKey: operationId });
const current = await runtime.runUntilSettled(poll, run.id);
```

Use stable submission keys after uncertain acknowledgements. Resume the loop explicitly after a waiting body is answered or becomes due. Treat `limit_exceeded` as a distinct operational outcome rather than success.
