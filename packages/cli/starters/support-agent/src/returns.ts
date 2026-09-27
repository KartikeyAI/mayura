import { createHash } from 'node:crypto';
import { defineTool } from '@mayura/sdk';
import { defineWorkflowLifecycle } from '@mayura/workflows/lifecycle';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);

/** Your returns system (RMA desk, warehouse or helpdesk). */
export interface ReturnsDesk {
  /**
   * Open the return for one delivered order, or find the one already open. Must be idempotent per (customer, order):
   * a customer who asks twice, or a retried tool call, gets the same return.
   */
  open(request: { readonly customerId: string; readonly orderId: string; readonly reason: string }):
    Promise<{ readonly returnId: string; readonly created: boolean; readonly instructions: string }>;
  /** Remind the customer to ship a return that has not arrived yet. Idempotent per returnId; false when nothing is due. */
  remind(request: { readonly returnId: string; readonly customerId: string; readonly orderId: string }):
    Promise<{ readonly reminded: boolean; readonly messageId: string | null }>;
}

const reference = (prefix: string, value: string): string => `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;

/**
 * SIMULATED returns desk: no network, nothing leaves the process. Return ids are derived from (customer, order), so they
 * are stable across restarts, but "already open" is only remembered in memory, per process. Replace it before real
 * customers use the assistant.
 */
export function simulatedReturnsDesk(): ReturnsDesk {
  const opened = new Set<string>();
  return {
    open: async ({ customerId, orderId }) => {
      const returnId = reference('ret', `${customerId}\n${orderId}`);
      const created = !opened.has(returnId); opened.add(returnId);
      return { returnId, created, instructions: 'A prepaid return label is on its way by email. Pack the items and drop the parcel at any carrier point within 30 days.' };
    },
    remind: async ({ returnId }) => ({ reminded: true, messageId: reference('msg', returnId) }),
  };
}

/**
 * What a follow-up run carries. Everything comes from the returns tool, never from the model. It holds no clock value,
 * so repeating the submission for the same return is an exact duplicate and finds the run it already started.
 */
export const followUpInput = z.strictObject({ returnId: identifier, customerId: identifier, orderId: identifier });
export type FollowUpInput = z.infer<typeof followUpInput>;
const scheduleOutput = z.strictObject({ remindAtMs: z.number().int().min(0).max(8_640_000_000_000_000) });
const followUpOutput = z.strictObject({ reminded: z.boolean(), messageId: z.string().max(128).nullable() });

/**
 * The durable part of support: after a return is opened, wait (durably, across restarts and deploys) and then remind the
 * customer once if the parcel is still outstanding. The server starts one run per return; the worker advances it.
 * Operators see every follow-up in the console and can pause, resume or cancel it.
 */
export function returnWorkflows(desk: ReturnsDesk, options: { readonly reminderDelayMs: number }) {
  // The first step fixes the reminder time. Its result is journaled, so the timer never moves on a restart or retry.
  const schedule = defineTool({
    id: 'returns.schedule', version: '1', effects: 'none', capabilities: [],
    description: 'Decide when to remind the customer about an outstanding return.',
    input: followUpInput, output: scheduleOutput,
    execute: () => ({ remindAtMs: Date.now() + options.reminderDelayMs }),
  });
  const remind = defineTool({
    id: 'returns.remind', version: '1', effects: 'write', capabilities: ['customers:notify'],
    description: 'Remind the customer to ship an outstanding return.',
    input: followUpInput, output: followUpOutput,
    execute: request => desk.remind(request),
  });
  const whole = { kind: 'input', path: [] } as const;
  const followUp = defineWorkflowLifecycle({
    id: 'returns.follow-up', version: '1', input: followUpInput, output: followUpOutput,
    nodes: [
      { kind: 'tool', id: 'schedule', tool: schedule, input: whole },
      { kind: 'timer', id: 'wait', fireAtMs: { kind: 'step', stepId: 'schedule', path: ['remindAtMs'] }, dependsOn: ['schedule'] },
      { kind: 'tool', id: 'remind', tool: remind, input: whole, dependsOn: ['wait'] },
    ],
    result: { kind: 'step', stepId: 'remind', path: [] },
  });
  return {
    /** New follow-ups start here. */
    latest: followUp,
    /** Every version that may still have runs in flight. When you change the workflow, add a version; keep this one. */
    definitions: [followUp],
    /** What the workflow runtime must allow: each tool, the capability it declares and the write effect. */
    permissions: ['tool:returns.schedule', 'tool:returns.remind', 'customers:notify', 'effect:write'],
  } as const;
}
