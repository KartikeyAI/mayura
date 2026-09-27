import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPostgresStore } from 'mayura/storage-postgres';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createWorkflowFleetControl } from 'mayura/workflows';
import type { Config } from './config.js';
import { returnWorkflows, simulatedReturnsDesk, type ReturnsDesk } from './returns.js';

/**
 * Storage and the pieces the server and the worker share. Both must use the same store, scope and definitions.
 * One store holds everything: native memory (per customer scope), durable follow-ups and the submission journal.
 */
export async function openServices(config: Config, options: { readonly returns?: ReturnsDesk } = {}) {
  let store;
  if (config.storage.kind === 'postgres') store = createPostgresStore({ connectionString: config.storage.connectionString });
  else {
    const filename = config.storage.filename === ':memory:' ? ':memory:' : resolve(config.storage.filename);
    if (filename !== ':memory:') await mkdir(dirname(filename), { recursive: true });
    store = createSqliteStore({ filename });
  }
  await store.initialize();
  // Native memory keeps its own tables (records, terms, vectors); they are created separately from the base schema.
  await store.memory.initialize();
  // Replace the simulated returns desk with your returns system before real customers use the assistant.
  const returns = options.returns ?? simulatedReturnsDesk();
  const workflows = returnWorkflows(returns, { reminderDelayMs: config.returnReminderMs });
  const runtimeOptions = { store, scope: config.scope, permissions: { allow: [...workflows.permissions] }, policyVersion: '1', maxCostMicros: 0 };
  // The durable fleet hold: operators can stop every worker from advancing follow-ups, for example during an incident.
  const fleet = createWorkflowFleetControl({ store, scope: config.scope });
  return { store, returns, workflows, runtimeOptions, fleet, close: () => store.close() };
}
export type Services = Awaited<ReturnType<typeof openServices>>;
