import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createWorkflowGraphCoordinator, defineWorkflowGraph } from '@mayura/workflows/graphs';

// Owned process only: stop after the real first finalization commit, before its acknowledgement.
const notify = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
let store; let coordinator;
try {
  const config = JSON.parse(process.argv[2] ?? 'null');
  if (!process.send || !config || !Array.isArray(config.definitions) || config.definitions.length !== 2
    || !/^[a-f0-9]{64}$/.test(config.firstRunId)) throw new Error();
  const backend = config.backend;
  if (backend.kind === 'sqlite' && !backend.filename.includes('mayura-graph-workflows-')) throw new Error();
  if (backend.kind === 'postgres' && !/^mayura_graph_workflow_[a-f0-9]{32}$/.test(backend.schema)) throw new Error();
  if (!['sqlite', 'postgres'].includes(backend.kind)) throw new Error();
  store = backend.kind === 'sqlite' ? createSqliteStore({ filename: backend.filename })
    : createPostgresStore({ connectionString: backend.connectionString, schema: backend.schema });
  await store.initialize(); await store.workflowGraphs.initialize();
  const effects = [0, 0];
  const definitions = config.definitions.map((entry, index) => {
    const tool = defineTool({ id: 'coordinator.effect', version: '1', description: 'Controlled coordinator effect',
      input: z.unknown(), output: z.unknown(), effects: 'write', capabilities: [], costMicros: 1, timeoutMs: 15_000,
      execute: input => { effects[index]++; return input; } });
    return { definition: defineWorkflowGraph({ id: entry.id, version: '1', input: z.unknown(), output: z.unknown(),
      nodes: [{ kind: 'tool', id: 'write', tool, input: { kind: 'input', path: [] }, approval: false }],
      result: { kind: 'step', stepId: 'write', path: [] } }), resources: entry.resources };
  });
  const underlying = store.workflowGraphs;
  const wrapped = { ...store, workflowGraphs: { ...underlying, async finalize(command) {
    const reply = await underlying.finalize(command);
    if (command.id === config.firstRunId) {
      await notify({ kind: 'checkpoint', effects });
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    }
    return reply;
  } } };
  coordinator = createWorkflowGraphCoordinator({ ...config.options, store: wrapped, workerId: 'coordinator-crash-worker', definitions });
  await coordinator.runPage();
  throw new Error();
} catch {
  await notify({ kind: 'fixture-error' }).catch(() => {});
  await coordinator?.close().catch(() => {}); await store?.close().catch(() => {});
  process.exitCode = 1; if (process.connected) process.disconnect();
}
