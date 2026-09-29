import { defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';
import { z } from 'zod';

// Every step is recorded before it starts and after it ends, so a run survives restarts.
const refund = defineWorkflowLifecycle({
  id: 'orders.refund', version: '1',
  input: z.object({ orderId: z.string(), amountCents: z.number() }),
  output: z.object({ refundId: z.string() }),
  nodes: [
    { kind: 'tool', id: 'check', tool: checkPolicy, input: { kind: 'input', path: [] } },
    // Waits, for days if need be, until a person approves this exact payment.
    { kind: 'tool', id: 'pay', tool: issueRefund, approval: true, dependsOn: ['check'],
      input: { kind: 'step', stepId: 'check', path: [] } },
  ],
  result: { kind: 'step', stepId: 'pay', path: [] },
});

// The same idempotency key returns the same run, so a refund is never paid twice.
const run = await runtime.submit(refund, { input: { orderId: 'o-1001', amountCents: 4_200 }, idempotencyKey: 'o-1001' });
