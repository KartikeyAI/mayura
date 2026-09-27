import { createHash } from 'node:crypto';
import { defineTool } from 'mayura';
import { defineWorkflowLifecycle, defineWorkflowMigration } from 'mayura/workflows/lifecycle';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);

/** What a refund run carries. Order facts come from the order directory, never from the model. */
export const refundRequest = z.strictObject({
  refundId: identifier,
  customerId: identifier,
  orderId: identifier,
  amountCents: z.number().int().min(1).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  reason: z.string().min(1).max(2_000),
  category: z.enum(['damaged', 'not_received', 'wrong_item', 'changed_mind', 'other']),
  riskTier: z.enum(['low', 'medium', 'high']),
  summary: z.string().min(1).max(500),
});
export type RefundRequest = z.infer<typeof refundRequest>;

/** Your payment provider. A refund must be idempotent on `refundId`, so a retried call never pays twice. */
export interface PaymentGateway {
  refund(refund: { readonly refundId: string; readonly orderId: string; readonly amountCents: number; readonly currency: string }): Promise<{ readonly receiptId: string }>;
}
/** Your customer messaging (email, SMS, in-app). Idempotent on `refundId`. */
export interface CustomerNotifier {
  send(message: { readonly refundId: string; readonly customerId: string; readonly text: string }): Promise<{ readonly messageId: string }>;
}

const reference = (prefix: string, value: string): string => `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
/** Local stand-ins: deterministic receipts and message ids, no network. Replace both before handling real money. */
export const simulatedPayments: PaymentGateway = { refund: async refund => ({ receiptId: reference('re', refund.refundId) }) };
export const simulatedNotifier: CustomerNotifier = { send: async message => ({ messageId: reference('msg', message.refundId) }) };

export interface RefundDependencies {
  readonly payments: PaymentGateway;
  readonly notifier: CustomerNotifier;
  /** Largest refund the workflow will ever pay, in minor units; larger requests fail at the policy step. */
  readonly refundLimitCents: number;
}

/**
 * Two versions of one durable workflow, and the reviewed migration between them.
 *
 * v1: check policy, then issue the refund once an operator approves the exact request.
 * v2: also notifies the customer after the refund is issued.
 *
 * New refunds start on the latest version. Runs already in flight keep the version they started on until an operator
 * migrates them (console, or `POST /v1/workflow-runs/:id/migrations` through the operator API); the migration is planned and shown before it applies.
 * Keep every version with runs in flight registered.
 */
export function refundWorkflows(dependencies: RefundDependencies) {
  const policy = defineTool({
    id: 'refunds.policy', version: '1', description: 'Check a refund request against the refund policy.',
    input: refundRequest, output: z.strictObject({ reviewNotes: z.array(z.string()) }), effects: 'none', capabilities: [],
    execute: request => {
      if (request.amountCents > dependencies.refundLimitCents) throw new Error('Refund exceeds the policy limit.');
      const reviewNotes = [`${request.category} (${request.riskTier} risk): ${request.summary}`];
      if (request.riskTier === 'high') reviewNotes.push('High risk: confirm the order and customer history before approving.');
      return { reviewNotes };
    },
  });
  const issue = defineTool({
    id: 'refunds.issue', version: '1', description: 'Issue the refund through the payment gateway.',
    input: refundRequest, output: z.strictObject({ receiptId: z.string() }), effects: 'write', capabilities: ['payments:refund'],
    execute: request => dependencies.payments.refund(request),
  });
  const notify = defineTool({
    id: 'refunds.notify', version: '1', description: 'Tell the customer their refund was issued.',
    input: refundRequest, output: z.strictObject({ messageId: z.string() }), effects: 'write', capabilities: ['customers:notify'],
    execute: request => dependencies.notifier.send({ refundId: request.refundId, customerId: request.customerId,
      text: `Your refund of ${(request.amountCents / 100).toFixed(2)} ${request.currency} for order ${request.orderId} is on its way.` }),
  });

  const whole = { kind: 'input', path: [] } as const;
  const steps = [
    { kind: 'tool', id: 'policy', tool: policy, input: whole },
    // `approval: true` stops the run until an operator approves this exact request; nothing is paid before that.
    { kind: 'tool', id: 'issue', tool: issue, input: whole, dependsOn: ['policy'], approval: true },
  ] as const;
  const output = z.strictObject({ receiptId: z.string() });
  const v1 = defineWorkflowLifecycle({ id: 'refunds.approval', version: '1', input: refundRequest, output, nodes: [...steps],
    result: { kind: 'step', stepId: 'issue', path: [] } });
  const v2 = defineWorkflowLifecycle({ id: 'refunds.approval', version: '2', input: refundRequest, output, nodes: [...steps,
    { kind: 'tool', id: 'notify', tool: notify, input: whole, dependsOn: ['issue'] }], result: { kind: 'step', stepId: 'issue', path: [] } });
  const migration = defineWorkflowMigration({ id: 'refunds-approval-1-to-2', from: v1, to: v2,
    description: 'Notify the customer once the refund is issued.' });

  return {
    /** New runs start here. */
    latest: v2,
    /** Every version that may still have runs in flight. */
    definitions: [v1, v2],
    migrations: [migration],
    /** What the workflow runtime must allow: each tool, each capability it declares, and the write effect. */
    permissions: ['tool:refunds.policy', 'tool:refunds.issue', 'tool:refunds.notify', 'payments:refund', 'customers:notify', 'effect:write'],
    v1,
  } as const;
}
