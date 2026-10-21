import { defineAgent, defineTool, z } from 'mayura';
import { createAgentServer } from 'mayura/server';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { identityDirectory, agentId } from './auth.mjs';
import { workflowServices } from './workflows.mjs';

/** All adapters, including edge hosts, receive the same persistent store and host-verified identity directory. */
export async function createApplication({ store, publicOrigin, projectId, sessions, modelOverride }) {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error('Invalid public origin.');
  const directory = identityDirectory(projectId, sessions);
  await store.initialize(); await store.threads.initialize();
  const workflows = directory.scopes.map(scope => workflowServices(store, scope));
  const save = defineTool({ id: 'notes.save', version: '1', description: 'Save this note and schedule local indexing after your approval.',
    input: z.object({ text: z.string().trim().min(1).max(2000) }).strict(), output: z.object({ saved: z.literal(true), noteId: z.string() }).strict(),
    effects: 'write', capabilities: ['notes:write'], approval: 'required', costMicros: 0, timeoutMs: 5000,
    execute: async ({ text }, context) => {
      context.signal.throwIfAborted(); const scope = context.scope;
      const index = directory.scopes.findIndex(item => item.principalId === scope.principalId && item.projectId === scope.projectId);
      if (index < 0) throw new Error('Scope refused.');
      const noteId = `${context.runId}:${context.callId}`;
      // Effect-local idempotency is still needed: a checkpoint is not an external-effect transaction.
      await store.create({ scope: JSON.stringify([scope.principalId, scope.projectId, 'notes']), id: noteId, idempotencyKey: noteId,
        definitionHash: 'notebook-note-v1', state: { text }, events: [{ type: 'note.saved', data: { text } }] });
      await workflows[index].host.runtime.submit(workflows[index].definition, { idempotencyKey: noteId, input: { noteId } });
      return { saved: true, noteId };
    } });
  // Deterministic fixture: no provider key or paid model request. One approval-required write per submitted turn.
  const model = modelOverride ?? Object.freeze({ id: 'notebook.fixture', maxCostMicros: 0, capabilities: { tools: true, structuredOutput: true, history: true },
    async generate(request) {
      request.signal.throwIfAborted();
      const result = request.messages.findLast(item => item.role === 'tool');
      if (result) return { type: 'final', output: { reply: result.result?.saved === true ? 'Saved after your approval. Indexing is queued.' : 'The note was not saved.' }, usage: { costMicros: 0 } };
      const input = request.messages.find(item => item.role === 'user')?.content;
      return { type: 'tool_calls', calls: [{ id: crypto.randomUUID(), toolId: save.id, input: { text: input.message } }], usage: { costMicros: 0 } };
    } });
  const agent = defineAgent({ id: agentId, version: '1', instructions: 'Propose one note write, then report its approved result.',
    input: z.object({ message: z.string().trim().min(1).max(2000) }).strict(), output: z.object({ reply: z.string() }).strict(), tools: [save], model });
  const server = createAgentServer({ publicOrigin, mounted: true, agents: [{ agent,
    permissions: { allow: [`model:${model.id}`, 'tool:notes.save', 'notes:write', 'effect:write'] },
    limits: { maxCostMicros: 0, maxSteps: 3, maxModelCalls: 2, maxToolCalls: 1, maxDurationMs: 10000 } }],
    authenticate: directory.authenticate, threads: { store }, runRecords: createAggregateRunRecords(store), runExecution: 'request',
    conversationRecovery: { permissions: { allow: ['conversations:recover'] }, pageSize: 25,
      authorize: async ({ scope, agentId: requested, signal }) => !signal.aborted && requested === agentId && directory.scopes.some(item => item.principalId === scope.principalId && item.projectId === scope.projectId) },
    limits: { maxRuns: 128, maxRuntimes: 32, maxRequests: 32, maxStreams: 16, maxBodyBytes: 16384, maxResponseBytes: 1048576,
      requestTimeoutMs: 15000, streamDurationMs: 5000, runRecordPollMs: 100 } });
  let recoveryCursor; let closed = false; let recovering;
  return Object.freeze({ server, store, workflows,
    async fetch(request) {
      const url = new URL(request.url); const prefix = '/api/mayura';
      if (!url.pathname.startsWith(`${prefix}/`)) return new Response('Not found', { status: 404 });
      url.pathname = url.pathname.slice(prefix.length);
      return server.fetch(new Request(url, request));
    },
    async runOnce() {
      if (closed) throw new Error('Application closed.');
      if (recovering) return recovering;
      recovering = (async () => {
        const recovery = await server.recoverConversations({ limit: 25, ...(recoveryCursor ? { after: recoveryCursor } : {}) });
        recoveryCursor = recovery.next ?? undefined;
        const reports = []; for (const item of workflows) reports.push(await item.worker.runOnce({ budgetMs: 1000 }));
        if (recovery.outcomes.some(item => item.status === 'retry') || reports.some(item => item.failures.length)) throw new Error('Background work needs attention.');
        return { recovered: recovery.outcomes.length, scopes: reports.length };
      })();
      try { return await recovering; } finally { recovering = undefined; }
    },
    async close() {
      if (closed) return; closed = true;
      await recovering?.catch(() => undefined); await server.close();
      for (const item of workflows) { await item.worker.drain(); await item.host.close(); }
      await store.close();
    },
  });
}
