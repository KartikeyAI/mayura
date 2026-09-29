const fulfil = defineWorkflowLifecycle({
  id: 'orders.fulfil',
  version: '1',
  input: order,
  output: z.object({ messageId: z.string() }),
  nodes: [
    { kind: 'tool', id: 'reserve', tool: reserve, input: { kind: 'input', path: [] } },
    { kind: 'tool', id: 'confirm', tool: confirm, dependsOn: ['reserve'], input: { kind: 'step', stepId: 'reserve', path: [] } },
  ],
  result: { kind: 'step', stepId: 'confirm', path: [] },
});

const store = createSqliteStore({ filename: 'workflows.sqlite' });
await store.initialize();

const runtime = createWorkflowLifecycleRuntime({
  store,
  scope: { principalId: 'orders-service', projectId: 'shop' },
  permissions: { allow: ['tool:orders.reserve', 'inventory:reserve', 'tool:orders.confirm', 'email:send', 'effect:write'] },
  policyVersion: '1',
  maxCostMicros: 0,
});

// The same idempotency key returns the same run, so an order is never fulfilled twice.
const run = await runtime.submit(fulfil, { input: { orderId: 'o-1001', email: 'ada@example.com' }, idempotencyKey: 'o-1001' });
const settled = await runtime.runUntilSettled(fulfil, run.id);
