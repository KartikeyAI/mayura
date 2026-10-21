import { defineAgent, z } from 'mayura';
import { defineTool } from 'mayura/tools';
import { createAggregateRunRecords } from 'mayura/storage';

export const agentId = 'chat.notes';
export const demoScope = Object.freeze({ principalId: 'local-user', projectId: 'thread-chat' });
export const replySchema = z.object({ reply: z.string() });
const noteSchema = z.object({ text: z.string().min(1).max(2_000) });

/** A deterministic local adapter, not inference: every message proposes saving one note, then reports the result. */
export function createChatServerOptions(store, authenticate) {
  const save = defineTool({ id: 'notes/save', version: '1', description: 'Save this message as a local SQLite note.',
    input: noteSchema, output: z.object({ saved: z.literal(true), noteId: z.string() }),
    effects: 'write', capabilities: [], approval: 'required', costMicros: 0, timeoutMs: 5_000,
    execute: async ({ text }, context) => {
      context.signal.throwIfAborted();
      // An effect's own idempotency key is still needed: approval/checkpoint ownership is not an external-effect transaction.
      const id = `${context.runId}:${context.callId}`;
      await store.create({ scope: JSON.stringify([context.scope.principalId, context.scope.projectId, 'notes']), id,
        idempotencyKey: id, definitionHash: 'thread-chat-note-v1', state: { text }, events: [{ type: 'note.saved', data: { text } }] });
      return { saved: true, noteId: id };
    } });
  const model = Object.freeze({ id: 'thread-chat-demo', maxCostMicros: 0,
    capabilities: Object.freeze({ tools: true, structuredOutput: true, history: true }),
    async generate(request) {
      request.signal.throwIfAborted();
      const result = request.messages.findLast(message => message.role === 'tool');
      if (result) return { type: 'final', output: { reply: result.result?.saved === true ? 'Saved your note after approval.' : 'Your note was not saved. The tool was not approved.' }, usage: { costMicros: 0 } };
      const input = request.messages.find(message => message.role === 'user')?.content;
      return { type: 'tool_calls', calls: [{ id: crypto.randomUUID(), toolId: save.id, input: { text: input.message } }], usage: { costMicros: 0 } };
    } });
  const agent = defineAgent({ id: agentId, version: '1', instructions: 'Propose saving one note, then report whether it was saved.',
    input: z.object({ message: z.string().trim().min(1).max(2_000) }), output: replySchema, tools: [save], model });
  return { agents: [{ agent, permissions: { allow: ['model:thread-chat-demo', 'tool:notes/save', 'effect:write'] },
    limits: { maxCostMicros: 0, maxSteps: 3, maxModelCalls: 2, maxToolCalls: 1, maxDurationMs: 10_000 } }],
    authenticate, threads: { store }, runRecords: createAggregateRunRecords(store), runExecution: 'request',
    conversationRecovery: { permissions: { allow: ['conversations:recover'] }, pageSize: 25,
      authorize: async ({ scope, agentId: requestedAgent, signal }) => !signal.aborted && requestedAgent === agentId
        && scope.principalId === demoScope.principalId && scope.projectId === demoScope.projectId },
    limits: { maxRuns: 64, maxRuntimes: 4, maxRequests: 32, maxStreams: 8, streamDurationMs: 5_000,
      runRecordPollMs: 100, requestTimeoutMs: 10_000, maxBodyBytes: 16_384, maxResponseBytes: 1_048_576 } };
}
