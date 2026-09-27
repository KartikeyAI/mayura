import { createAggregateSubmissionJournal } from '@mayura/storage-contracts';
import { listenAgentServer, listenProductionServer } from '@mayura/server-node';
import { createWorkflowCommandJournal, createWorkflowMigrationCatalog, createWorkflowOperatorTransports, lifecycleOperatorTarget } from '@mayura/workflows';
import { createWorkflowLifecycleFleetRuntime } from '@mayura/workflows/lifecycle';
import { approvalCredential, authenticate, verifyApprover } from './auth.js';
import type { Config } from './config.js';
import { intakeAgent, sampleOrders, type OrderDirectory } from './intake.js';
import { modelPermission } from './model.js';
import type { Services } from './services.js';

export interface RunningServer { readonly origin: string; isAccepting(): boolean; close(): Promise<void> }

/**
 * The HTTP side: the intake agent for the support system, the operator console at /inspector and the operator API.
 * It submits refund runs but never advances them; that is the worker's job.
 */
export async function startServer(config: Config, services: Services, options: { readonly orders?: OrderDirectory } = {}): Promise<RunningServer> {
  const { store, workflows, runtimeOptions, fleet } = services; const { scope } = config;
  const runtime = createWorkflowLifecycleFleetRuntime({ ...runtimeOptions, verifyHuman: verifyApprover(scope.projectId) });
  const intake = intakeAgent({
    model: config.model,
    // Replace the sample orders with a lookup in your order system.
    orders: options.orders ?? sampleOrders,
    // Idempotent: a retried request for the same refund finds the run it already started.
    openRefund: async request => ({ runId: (await runtime.submit(workflows.latest, { input: request, idempotencyKey: request.refundId })).id }),
  });
  // Production operator adapters: journaled commands (a retried command id never applies twice), revision checks,
  // views across every registered version, fleet hold and sweeps, and the reviewed migrations.
  const operator = createWorkflowOperatorTransports({ store, scope, journal: createWorkflowCommandJournal({ store, scope }), fleet,
    migrations: createWorkflowMigrationCatalog([...workflows.migrations]),
    targets: [lifecycleOperatorTarget({ runtime, store, scope, definitions: [...workflows.definitions], approvalCredential })] });
  const settings = {
    agents: [{ agent: intake.agent, permissions: { allow: [modelPermission(intake.model), ...intake.permissions] },
      limits: { maxSteps: 4, maxModelCalls: 3, maxToolCalls: 1, maxDurationMs: 60_000, maxCostMicros: config.maxRunCostMicros } }],
    authenticate: authenticate(config, intake.agent.id),
    // A retried submission after a restart is refused instead of starting a second run.
    submissionJournal: createAggregateSubmissionJournal(store),
    inspector: true,
    allowedOrigins: config.server.allowedOrigins,
    ...operator,
    limits: { maxRequests: 256, maxRuns: 128, maxWorkflowOperations: 32, requestTimeoutMs: 30_000 },
  };

  if (config.environment === 'production') {
    const server = await listenProductionServer({ ...settings, publicOrigin: config.server.publicOrigin!, hostname: config.server.bind,
      port: config.server.port, tls: { terminatedBy: 'proxy' },
      readiness: async () => { await store.read('readiness', 'probe'); return true; } });
    return { origin: server.publicOrigin, isAccepting: () => server.isAccepting(),
      close: async () => { await server.close(); runtime.close(); } };
  }
  // Development: loopback only, plain HTTP.
  const server = await listenAgentServer({ ...settings, port: config.server.port });
  let accepting = true;
  return { origin: server.origin, isAccepting: () => accepting,
    close: async () => { accepting = false; await server.close(); runtime.close(); } };
}
