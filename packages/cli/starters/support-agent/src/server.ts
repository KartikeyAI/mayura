import type { ModelAdapter } from '@mayura/core';
import { createAggregateSubmissionJournal } from '@mayura/storage-contracts';
import { listenAgentServer, listenProductionServer } from '@mayura/server-node';
import { createWorkflowCommandJournal, createWorkflowOperatorTransports, lifecycleOperatorTarget } from '@mayura/workflows';
import { createWorkflowLifecycleFleetRuntime } from '@mayura/workflows/lifecycle';
import { supportAssistant } from './assistant.js';
import { authenticate } from './auth.js';
import type { Config } from './config.js';
import { modelPermission } from './model.js';
import { sampleOrders, type OrderDirectory } from './orders.js';
import type { Services } from './services.js';

export interface RunningServer { readonly origin: string; isAccepting(): boolean; close(): Promise<void> }
export interface ServerOptions {
  readonly orders?: OrderDirectory;
  /** Replace the model entirely (tests use it to play a hostile or scripted model). */
  readonly model?: ModelAdapter;
}

// The agent server keeps every run it started, and one runtime per signed-in customer, in memory until the process
// restarts; past these limits it answers 429. Restart (or scale out and rotate) servers well before you reach them.
// See README "Know the limits".
const maxRuns = 20_000; const maxCustomers = 5_000;

/**
 * The HTTP side: the support assistant for signed-in customers, the operator console at /inspector and the operator
 * API for return follow-ups. It starts follow-ups but never advances them; that is the worker's job.
 */
export async function startServer(config: Config, services: Services, options: ServerOptions = {}): Promise<RunningServer> {
  const { store, workflows, runtimeOptions, fleet } = services; const { scope } = config;
  const runtime = createWorkflowLifecycleFleetRuntime(runtimeOptions);
  const assistant = supportAssistant({
    model: config.model,
    ...(options.model ? { modelOverride: options.model } : {}),
    projectId: config.projectId,
    // Replace the sample orders with your order system (keep "orders of this customer" as the only query).
    orders: options.orders ?? sampleOrders,
    returns: services.returns,
    store,
    startFollowUp: async request => {
      // Idempotent: the return id is the submission key, so a repeated or retried request finds the run it started.
      await runtime.submit(workflows.latest, { idempotencyKey: `follow-up-${request.returnId}`, input: { ...request } });
    },
  });
  // Operators: journaled commands (a retried command id never applies twice), revision checks and the fleet hold.
  const operator = createWorkflowOperatorTransports({ store, scope, journal: createWorkflowCommandJournal({ store, scope }), fleet,
    targets: [lifecycleOperatorTarget({ runtime, store, scope, definitions: [...workflows.definitions] })] });
  const settings = {
    agents: [{ agent: assistant.agent, permissions: { allow: [modelPermission(assistant.model), ...assistant.permissions] },
      limits: { maxSteps: 6, maxModelCalls: 5, maxToolCalls: 4, maxDurationMs: 60_000, maxCostMicros: config.maxRunCostMicros } }],
    authenticate: authenticate(config, [assistant.agent.id]),
    // A retried submission after a restart is refused instead of starting a second run.
    submissionJournal: createAggregateSubmissionJournal(store),
    inspector: true,
    allowedOrigins: config.server.allowedOrigins,
    ...operator,
    limits: { maxRequests: 256, maxRuns, maxRuntimes: maxCustomers, maxStreams: 256, maxWorkflowOperations: 32, requestTimeoutMs: 30_000, streamDurationMs: 60_000 },
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
