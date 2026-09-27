import type { AnyTool } from 'mayura';
import { defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';
import { z } from 'zod';
import type { TrackerTools } from './tracker-tools.js';
import { ticket, triageOutput } from './triage.js';
import { assignee, ticketId } from './tracker/tickets.js';

/** What starts one intake run: the verified delivery's id and the ticket it announced. */
export const intakeRequest = z.strictObject({ deliveryId: z.string().min(1).max(128), ticket });

/** An escalation carries the exact tracker calls it will make, so the operator approves what will actually happen. */
export const escalationRequest = z.strictObject({
  reason: z.string().min(1).max(500),
  assignment: z.strictObject({ ticketId, assignee }),
  announcement: z.strictObject({ ticketId, body: z.string().min(1).max(2_000) }),
});
export type EscalationRequest = z.infer<typeof escalationRequest>;

export function escalationFor(request: { readonly ticketId: string; readonly reason: string }, oncall: string): EscalationRequest {
  return { reason: request.reason, assignment: { ticketId: request.ticketId, assignee: oncall },
    announcement: { ticketId: request.ticketId, body: `[automated triage] An operator approved escalation; ${oncall} now owns this ticket.` } };
}

/**
 * Two durable workflows.
 *
 * tickets.intake v1: one run per verified webhook delivery. The triage agent labels and comments on the ticket through
 * MCP, and for an urgent ticket asks for an escalation.
 *
 * tickets.escalation v1: one run per escalated ticket. `approval: true` stops the run before `assign` until an operator
 * approves that exact call (ticket and assignee); only then is the ticket assigned and the reporter told.
 *
 * Never edit a version that has runs in flight: add a new version and a migration (see the approval-workflow starter).
 */
export function ticketWorkflows(dependencies: { readonly tools: TrackerTools; readonly triage: AnyTool; readonly revoke?: readonly string[] }) {
  const { tools, triage } = dependencies;
  const intake = defineWorkflowLifecycle({ id: 'tickets.intake', version: '1', input: intakeRequest, output: triageOutput,
    nodes: [{ kind: 'tool', id: 'triage', tool: triage, input: { kind: 'input', path: ['ticket'] } }],
    result: { kind: 'step', stepId: 'triage', path: [] } });
  const escalation = defineWorkflowLifecycle({ id: 'tickets.escalation', version: '1', input: escalationRequest,
    output: z.strictObject({ ticketId, assignee }),
    nodes: [
      { kind: 'tool', id: 'assign', tool: tools.assign, input: { kind: 'input', path: ['assignment'] }, approval: true },
      { kind: 'tool', id: 'announce', tool: tools.comment, input: { kind: 'input', path: ['announcement'] }, dependsOn: ['assign'] },
    ],
    result: { kind: 'step', stepId: 'assign', path: [] } });
  const revoked = new Set(dependencies.revoke ?? []);
  return {
    intake, escalation,
    /** Every version that may still have runs in flight. */
    definitions: [intake, escalation],
    /** What the workflow runtime must allow: each step's tool, each capability it declares, and the write effect. */
    permissions: ['tool:tickets.triage.run', 'tickets:triage', 'tool:tickets.assign', 'tickets:assign', 'tool:tickets.comment', 'tickets:write', 'effect:write']
      .filter(grant => !revoked.has(grant)),
  } as const;
}
export type TicketWorkflows = ReturnType<typeof ticketWorkflows>;
