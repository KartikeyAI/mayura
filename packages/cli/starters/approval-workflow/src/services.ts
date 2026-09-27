import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPostgresStore } from 'mayura/storage-postgres';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createWorkflowFleetControl } from 'mayura/workflows';
import type { Config } from './config.js';
import { refundWorkflows, simulatedNotifier, simulatedPayments } from './workflow.js';

/** Storage and the pieces the server and the worker share. Both must use the same store, scope and definitions. */
export async function openServices(config: Config) {
  let store;
  if (config.storage.kind === 'postgres') store = createPostgresStore({ connectionString: config.storage.connectionString });
  else {
    const filename = config.storage.filename === ':memory:' ? ':memory:' : resolve(config.storage.filename);
    if (filename !== ':memory:') await mkdir(dirname(filename), { recursive: true });
    store = createSqliteStore({ filename });
  }
  await store.initialize();
  // Replace the simulated payment gateway and notifier with your providers before handling real money.
  const workflows = refundWorkflows({ payments: simulatedPayments, notifier: simulatedNotifier, refundLimitCents: config.refundLimitCents });
  const runtimeOptions = { store, scope: config.scope, permissions: { allow: [...workflows.permissions] }, policyVersion: '1', maxCostMicros: 0 };
  // The durable fleet hold: operators can stop every worker from advancing runs, for example during an incident.
  const fleet = createWorkflowFleetControl({ store, scope: config.scope });
  return { store, workflows, runtimeOptions, fleet, close: () => store.close() };
}
export type Services = Awaited<ReturnType<typeof openServices>>;
