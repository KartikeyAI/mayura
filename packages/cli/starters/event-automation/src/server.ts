import { createAggregateSubmissionJournal } from 'mayura/storage-contracts';
import { listenAgentServer, listenProductionServer } from 'mayura/server-node';
import { createWorkflowCommandJournal, createWorkflowOperatorTransports, lifecycleOperatorTarget } from 'mayura/workflows';
import { createWorkflowLifecycleFleetRuntime } from 'mayura/workflows/lifecycle';
import { approvalCredential, authenticate, verifyApprover } from './auth.js';
import type { Config } from './config.js';
import { startWebhookIngress } from './ingress.js';
import type { Services } from './services.js';

export interface RunningServer { readonly origin: string; readonly webhookUrl: string; isAccepting(): boolean; close(): Promise<void> }

/**
 * The HTTP side, as one handle: the Mayura server (operator console at /inspector, operator API) and the webhook
 * ingress on its own port. Verified deliveries start durable runs; the worker advances them. Nothing here calls the
 * tracker.
 */
export async function startServer(config: Config, services: Services): Promise<RunningServer> {
  const { store, workflows, runtimeOptions, fleet, triage } = services; const { scope } = config;
  const runtime = createWorkflowLifecycleFleetRuntime({ ...runtimeOptions, verifyHuman: verifyApprover(scope.projectId) });
  // Production operator adapters: journaled commands (a retried command id never applies twice), revision checks,
  // views across every registered definition, pending approvals with their exact tool call, and the fleet hold.
  const operator = createWorkflowOperatorTransports({ store, scope, journal: createWorkflowCommandJournal({ store, scope }), fleet,
    targets: [lifecycleOperatorTarget({ runtime, store, scope, definitions: [...workflows.definitions], approvalCredential })] });
  const settings = {
    // The triage agent is registered so operators can see its definition in the console. It runs inside the durable
    // intake workflow; no caller of this API holds `runs:submit`, so it cannot be started from here.
    agents: [{ agent: triage.agent, permissions: { allow: [...triage.grants] }, limits: triage.limits }],
    authenticate: authenticate(config, [triage.agent.id]),
    submissionJournal: createAggregateSubmissionJournal(store),
    inspector: true,
    allowedOrigins: config.server.allowedOrigins,
    ...operator,
    limits: { maxRequests: 256, maxRuns: 16, maxWorkflowOperations: 32, requestTimeoutMs: 30_000 },
  };

  let api: { readonly origin: string; isAccepting(): boolean; close(): Promise<void> };
  if (config.environment === 'production') {
    const server = await listenProductionServer({ ...settings, publicOrigin: config.server.publicOrigin!, hostname: config.server.bind,
      port: config.server.port, tls: { terminatedBy: 'proxy' },
      readiness: async () => { await store.read('readiness', 'probe'); return true; } });
    api = { origin: server.publicOrigin, isAccepting: () => server.isAccepting(), close: () => server.close() };
  } else {
    // Development: loopback only, plain HTTP.
    const server = await listenAgentServer({ ...settings, port: config.server.port });
    let accepting = true;
    api = { origin: server.origin, isAccepting: () => accepting, close: async () => { accepting = false; await server.close(); } };
  }
  let ingress;
  try { ingress = await startWebhookIngress(config, services); }
  catch (error) { await api.close(); runtime.close(); throw error; }
  const webhooks = ingress;
  return {
    origin: api.origin, webhookUrl: webhooks.url,
    isAccepting: () => api.isAccepting() && webhooks.isAccepting(),
    // Stop taking deliveries first, then the API.
    close: async () => { await webhooks.close(); await api.close(); runtime.close(); },
  };
}
