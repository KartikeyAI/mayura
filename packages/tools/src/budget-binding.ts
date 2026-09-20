import { assertBudgetTicket, MayuraError, type Budget, type BudgetTicket, type Scope, type Reservation } from '@mayura/core';
import { assertTool, type AnyTool } from './index.js';

/** Opaque trusted-host binding; none of the held accounting authority is public metadata. */
export interface ToolBudgetTicketBinding { readonly kind: 'mayura.tool-budget-ticket' }
export interface ToolBudgetTicketContext {
  readonly budget: Budget;
  readonly runId: string;
  readonly callId: string;
  readonly scope: Scope;
  readonly signal: AbortSignal;
}
interface Binding extends ToolBudgetTicketContext { readonly tool: AnyTool; readonly ticket: BudgetTicket; claimed: boolean }
const bindings = new WeakMap<ToolBudgetTicketBinding, Binding>();
const boundTickets = new WeakSet<BudgetTicket>();

function snapshotContext(value: ToolBudgetTicketContext): ToolBudgetTicketContext {
  try {
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = ['budget', 'runId', 'callId', 'scope', 'signal'] as const;
    if (keys.some(key => !fields[key] || !('value' in fields[key]))) throw new Error();
    const scope = Object.getOwnPropertyDescriptors(fields.scope!.value);
    if (!scope['principalId'] || !('value' in scope['principalId']) || !scope['projectId'] || !('value' in scope['projectId'])) throw new Error();
    const runId: unknown = fields.runId!.value; const callId: unknown = fields.callId!.value;
    const principalId: unknown = scope['principalId'].value; const projectId: unknown = scope['projectId'].value;
    if ([runId, callId, principalId, projectId].some(text => typeof text !== 'string' || text.trim().length === 0 || text.length > 256)
      || !(fields.signal!.value instanceof AbortSignal)) throw new Error();
    return { budget: fields.budget!.value as Budget, runId: runId as string, callId: callId as string,
      scope: Object.freeze({ principalId: principalId as string, projectId: projectId as string }), signal: fields.signal!.value as AbortSignal };
  } catch { throw new MayuraError('INVALID_CONFIG', 'A tool ticket requires an explicit plain invocation context.'); }
}

/** Bind existing authority to one exact invocation. This is host plumbing, not a permission grant or sandbox. */
export function bindToolBudgetTicket(tool: AnyTool, ticket: BudgetTicket, context: ToolBudgetTicketContext): ToolBudgetTicketBinding {
  const captured = snapshotContext(context);
  // All user-controlled reflection precedes final private identity checks and registration.
  assertTool(tool); assertBudgetTicket(ticket, captured.budget);
  if (ticket.maxCostMicros !== tool.costMicros) throw new MayuraError('INVALID_CONFIG', 'The ticket cost does not match the registered tool.');
  if (boundTickets.has(ticket)) throw new MayuraError('CONFLICT', 'This ticket is already bound to an invocation.');
  const handle: ToolBudgetTicketBinding = Object.freeze({ kind: 'mayura.tool-budget-ticket' });
  bindings.set(handle, { ...captured, ticket, tool, claimed: false }); boundTickets.add(ticket);
  return handle;
}

/** Internal broker seam: claim once before awaits, consume only at the existing dispatch point. */
export function claimToolBudgetTicket(value: ToolBudgetTicketBinding, tool: AnyTool, context: ToolBudgetTicketContext): () => Reservation {
  const binding = bindings.get(value);
  if (!binding || binding.tool !== tool || binding.budget !== context.budget || binding.runId !== context.runId
    || binding.callId !== context.callId || binding.signal !== context.signal
    || binding.scope.principalId !== context.scope.principalId || binding.scope.projectId !== context.scope.projectId) {
    throw new MayuraError('INVALID_CONFIG', 'The tool ticket binding does not match this invocation.');
  }
  if (binding.claimed) throw new MayuraError('CONFLICT', 'The tool ticket binding was already claimed.');
  assertBudgetTicket(binding.ticket, context.budget);
  binding.claimed = true;
  let consumed = false;
  return () => {
    if (consumed) throw new MayuraError('CONFLICT', 'The tool ticket was already consumed.');
    assertBudgetTicket(binding.ticket, binding.budget);
    const reservation = binding.ticket.start(); consumed = true;
    return reservation;
  };
}
