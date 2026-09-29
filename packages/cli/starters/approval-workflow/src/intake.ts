import type { ModelAdapter, ModelRequest, ModelResponse } from 'mayura/core';
import { defineAgent, defineTool, z } from 'mayura';
import type { ModelSettings } from './config.js';
import { jsonSchema, selectModel } from './model.js';
import { refundRequest, type RefundRequest } from './workflow.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);

/** A support system asks for a refund: the ticket, the order and the customer's own words. */
export const intakeInput = z.strictObject({
  ticketId: identifier,
  customerId: identifier,
  orderId: identifier,
  amountCents: z.number().int().min(1).max(100_000_000),
  reason: z.string().min(1).max(2_000),
});
export type IntakeInput = z.infer<typeof intakeInput>;

const judgement = { category: refundRequest.shape.category, riskTier: refundRequest.shape.riskTier, summary: refundRequest.shape.summary };
/** What the model decides. Identifiers and amounts are checked against the order directory by the tool. */
const openInput = z.strictObject({ ticketId: identifier, customerId: identifier, orderId: identifier, amountCents: z.number().int().min(1).max(100_000_000),
  reason: z.string().min(1).max(2_000), ...judgement });
export const intakeOutput = z.strictObject({ refundId: identifier, runId: z.string(), ...judgement });
export type IntakeOutput = z.infer<typeof intakeOutput>;

/** Your order system. The tool trusts it, not the model, for who owns an order and what it cost. */
export interface OrderDirectory {
  find(orderId: string): Promise<{ readonly orderId: string; readonly customerId: string; readonly totalCents: number; readonly currency: string } | undefined>;
}
/** Local stand-in with a few fixed orders. */
export const sampleOrders: OrderDirectory = {
  find: async orderId => ({
    'ord-1001': { orderId: 'ord-1001', customerId: 'cus-ada', totalCents: 4_999, currency: 'USD' },
    'ord-1002': { orderId: 'ord-1002', customerId: 'cus-ada', totalCents: 129_900, currency: 'USD' },
    'ord-2001': { orderId: 'ord-2001', customerId: 'cus-grace', totalCents: 18_450, currency: 'EUR' },
  } as Record<string, { orderId: string; customerId: string; totalCents: number; currency: string }>)[orderId],
};

export interface IntakeDependencies {
  readonly model: ModelSettings;
  readonly orders: OrderDirectory;
  /** Start (or find) the durable approval for one refund. Idempotent on `refundId`. */
  readonly openRefund: (request: RefundRequest) => Promise<{ readonly runId: string }>;
}

export function intakeAgent(dependencies: IntakeDependencies) {
  const open = defineTool({
    id: 'refunds.open', version: '1', effects: 'write', capabilities: ['refunds:open'],
    description: 'Open the durable refund approval for one order. Call exactly once, with your category, risk tier and a one-sentence summary for the reviewer.',
    input: openInput, inputJsonSchema: jsonSchema(openInput), output: z.strictObject({ refundId: identifier, runId: z.string() }),
    execute: async request => {
      const order = await dependencies.orders.find(request.orderId);
      if (!order || order.customerId !== request.customerId) throw new Error('The order does not belong to this customer.');
      if (request.amountCents > order.totalCents) throw new Error('The refund exceeds the order total.');
      const refundId = `rf-${request.ticketId}`;
      const { runId } = await dependencies.openRefund({ refundId, customerId: order.customerId, orderId: order.orderId, amountCents: request.amountCents,
        currency: order.currency, reason: request.reason, category: request.category, riskTier: request.riskTier, summary: request.summary });
      return { refundId, runId };
    },
  });
  const model = selectModel(dependencies.model, { outputJsonSchema: jsonSchema(intakeOutput), offline: offlineIntakeModel });
  const agent = defineAgent({
    id: 'refunds.intake', version: '1', input: intakeInput, output: intakeOutput, tools: [open], model,
    instructions: [
      'You triage refund requests for a support team.',
      'Classify the reason as damaged, not_received, wrong_item, changed_mind or other.',
      'Rate risk low, medium or high: larger amounts, vague reasons and repeat requests are riskier.',
      'Call refunds.open exactly once with the request fields unchanged plus your category, risk tier and a one-sentence summary for the human reviewer.',
      'Then answer with the refundId and runId it returned and the same category, risk tier and summary.',
    ].join('\n'),
  });
  return { agent, model, permissions: [`tool:${open.id}`, 'refunds:open', 'effect:write'] } as const;
}

// ---- Offline stand-in ------------------------------------------------------------------------------------------------
// Rule-based and deterministic: keyword classification and amount bands. It shows the tool-call protocol a real model
// follows; it is not inference and makes no judgement a real reviewer should rely on.

function classify(input: IntakeInput): Pick<IntakeOutput, 'category' | 'riskTier' | 'summary'> {
  const reason = input.reason.toLowerCase();
  const category = /broken|damaged|cracked|defect/u.test(reason) ? 'damaged'
    : /never (arrived|came)|not (received|delivered)|missing|lost/u.test(reason) ? 'not_received'
      : /wrong|incorrect|different (item|size|colou?r)/u.test(reason) ? 'wrong_item'
        : /changed my mind|no longer|don't (want|need)/u.test(reason) ? 'changed_mind' : 'other';
  const riskTier = input.amountCents >= 50_000 || category === 'other' ? 'high' : input.amountCents >= 10_000 ? 'medium' : 'low';
  return { category, riskTier, summary: `${category.replace('_', ' ')} refund request for order ${input.orderId} (ticket ${input.ticketId}).` };
}

export const offlineIntakeModel: ModelAdapter = {
  id: 'offline.refund-intake',
  capabilities: { tools: true, structuredOutput: true },
  maxCostMicros: 0,
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const first = request.messages[0];
    const input = intakeInput.parse(first?.role === 'user' ? first.content : undefined);
    const result = request.messages.find(message => message.role === 'tool');
    if (!result) {
      return { type: 'tool_calls', calls: [{ id: 'open-1', toolId: 'refunds.open', input: { ...input, ...classify(input) } }], usage: { costMicros: 0 } };
    }
    const opened = z.strictObject({ refundId: identifier, runId: z.string() }).parse(result.result);
    return { type: 'final', output: { ...opened, ...classify(input) }, usage: { costMicros: 0 } };
  },
};
