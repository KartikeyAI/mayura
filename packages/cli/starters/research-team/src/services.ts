import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createLocalArtifactStore } from 'mayura/artifacts';
import { createPostgresStore } from 'mayura/storage-postgres';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createWorkflowFleetControl } from 'mayura/workflows';
import { createWorkflowLifecycleRuntime } from 'mayura/workflows/lifecycle';
import type { Config } from './config.js';
import { harlowCreekCorpus } from './library/corpus.js';
import { localLibrary, type SourceLibrary } from './library/index.js';
import { createTelemetry } from './telemetry.js';
import { researchWorkflows } from './workflow.js';

/**
 * Storage and the pieces the server and the worker share. Both must use the same store, scope, definitions, budget
 * and artifact directory: the run budget and every step's ceiling are part of the pinned workflow policy.
 */
export async function openServices(config: Config, options: { readonly library?: SourceLibrary } = {}) {
  let store;
  if (config.storage.kind === 'postgres') store = createPostgresStore({ connectionString: config.storage.connectionString });
  else {
    const filename = config.storage.filename === ':memory:' ? ':memory:' : resolve(config.storage.filename);
    if (filename !== ':memory:') await mkdir(dirname(filename), { recursive: true });
    store = createSqliteStore({ filename });
  }
  await store.initialize();
  // Reports are content-addressed files on this machine. With several nodes, point every worker and server at shared
  // storage or replace the artifact store (README "Know the limits").
  const artifactsDirectory = resolve(config.artifactsDirectory);
  await mkdir(artifactsDirectory, { recursive: true });
  const artifacts = createLocalArtifactStore({ rootDirectory: artifactsDirectory, maxArtifactBytes: 262_144 });
  const artifactScope = { principalId: config.scope.principalId, projectId: config.scope.projectId };
  // Replace the bundled corpus with your own sources (README "Make it yours").
  const library = options.library ?? localLibrary(harlowCreekCorpus);
  const telemetry = createTelemetry(config.telemetry);
  const workflows = researchWorkflows({ model: config.model, library, artifacts, artifactScope, stepCostMicros: config.budget.stepMicros, telemetry });
  // `maxCostMicros` is the ONE budget of each research run, shared by the planner, every researcher and the writer.
  const runtimeOptions = { store, scope: config.scope, permissions: { allow: [...workflows.permissions] }, policyVersion: '1',
    maxCostMicros: config.budget.runMicros };
  // Traces of settled runs are read back from their durable event logs (see telemetry.ts); this runtime only reads.
  const traceSource = createWorkflowLifecycleRuntime(runtimeOptions);
  telemetry.exportWorkflows({ source: traceSource, store, scope: config.scope, definitions: workflows.definitions });
  // The durable fleet hold: operators can stop every worker from advancing runs, for example during an incident.
  const fleet = createWorkflowFleetControl({ store, scope: config.scope });
  return { store, library, artifacts, artifactScope, telemetry, workflows, runtimeOptions, fleet,
    close: async () => { await telemetry.close(); traceSource.close(); await store.close(); } };
}
export type Services = Awaited<ReturnType<typeof openServices>>;
