import { defineTool, z } from 'mayura';
import { createWorkflowLeadership, createWorkflowWorker } from 'mayura/workflows';
import { defineWorkflowLifecycle, createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';

/** Durable no-network indexing fixture; replace its effect with an idempotent integration before production use. */
export function workflowServices(store, scope) {
  const input = z.object({ noteId: z.string().min(1).max(256) }).strict();
  const index = defineTool({ id: 'notes.index', version: '1', description: 'Index an approved local note.', input,
    output: z.object({ indexed: z.literal(true) }).strict(), effects: 'write', capabilities: ['notes:index'], costMicros: 0,
    execute: async ({ noteId }, context) => {
      context.signal.throwIfAborted();
      if (context.scope.principalId !== scope.principalId || context.scope.projectId !== scope.projectId) throw new Error('Scope refused.');
      await store.create({ scope: JSON.stringify([scope.principalId, scope.projectId, 'note-index']), id: noteId, idempotencyKey: noteId,
        definitionHash: 'notebook-index-v1', state: { indexed: true }, events: [{ type: 'note.indexed', data: { noteId } }] });
      return { indexed: true };
    } });
  const definition = defineWorkflowLifecycle({ id: 'notes.follow-up', version: '1', input, output: z.object({ indexed: z.literal(true) }).strict(),
    nodes: [{ kind: 'tool', id: 'index', tool: index, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'index', path: [] } });
  const host = createWorkflowLifecycleHost({ store, scope, definitions: [definition], policyVersion: '1', maxCostMicros: 0,
    permissions: { allow: ['tool:notes.index', 'notes:index', 'effect:write'] }, intervalMs: 1000, maxPagesPerCycle: 1, pageLimit: 10 });
  const worker = createWorkflowWorker({ units: [host], leadership: createWorkflowLeadership({ store, scope, role: 'notebook-worker', holderId: crypto.randomUUID() }) });
  return Object.freeze({ definition, host, worker });
}
