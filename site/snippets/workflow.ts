import { z } from 'mayura';
import {
  defineWorkflowLifecycle,
} from 'mayura/workflows/lifecycle';

// Each step is recorded, so a run survives restarts.
export const refund = defineWorkflowLifecycle({
  id: 'orders.refund', version: '1',
  input: z.object({ orderId: z.string() }),
  output: z.object({ refundId: z.string() }),
  nodes: [
    { kind: 'tool', id: 'check', tool: checkPolicy,
      input: { kind: 'input', path: [] } },
    // Waits, for days if need be, for a person to approve.
    { kind: 'tool', id: 'pay', tool: issueRefund,
      approval: true, dependsOn: ['check'],
      input: { kind: 'step', stepId: 'check', path: [] } },
  ],
  result: { kind: 'step', stepId: 'pay', path: [] },
});
