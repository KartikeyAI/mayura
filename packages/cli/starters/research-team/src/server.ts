import { createAggregateSubmissionJournal } from '@mayura/storage-contracts';
import { listenAgentServer, listenProductionServer } from '@mayura/server-node';
import { createWorkflowCommandJournal, createWorkflowOperatorTransports, lifecycleOperatorTarget } from '@mayura/workflows';
import { createWorkflowLifecycleFleetRuntime } from '@mayura/workflows/lifecycle';
import { authenticate } from './auth.js';
import type { Config } from './config.js';
import { deskAgent, describeRun } from './desk.js';
import { libraryTools } from './library/index.js';
import type { Services } from './services.js';
import { plannerAgent, researcherAgent, writerAgent } from './team.js';

export interface RunningServer { readonly origin: string; isAccepting(): boolean; close(): Promise<void> }

/**
 * The HTTP side: the research desk for your application, the operator console at /inspector and the operator API.
 * It submits research runs but never advances them; that is the worker's job.
 */
export async function startServer(config: Config, services: Services): Promise<RunningServer> {
  const { store, workflows, runtimeOptions, fleet } = services; const { scope } = config;
  const runtime = createWorkflowLifecycleFleetRuntime(runtimeOptions);
  const desk = deskAgent({
    model: config.model,
    // Idempotent on the caller's request id: a retried request finds the run it already started. The same request id
    // with a different question is refused (the stored submission belongs to different content).
    start: async request => {
      const run = await runtime.submit(workflows.latest, { input: request, idempotencyKey: `research-${request.requestId}` });
      return { runId: run.id, status: run.status };
    },
    report: runId => describeRun({ runtime, artifacts: services.artifacts, artifactScope: services.artifactScope }, runId),
  });
  // The team's agents run inside workflow steps on the worker. They are registered here too so operators can see
  // their definitions in the console; no caller identity may submit them (see auth.ts).
  const library = libraryTools(services.library); const researcher = researcherAgent(config.model, library.tools);
  const team = [plannerAgent(config.model), { agent: researcher.agent, permissions: [...researcher.permissions, ...library.permissions] }, writerAgent(config.model)];
  const agentLimits = { maxSteps: 6, maxModelCalls: 5, maxToolCalls: 8, maxDurationMs: 120_000, maxCostMicros: config.budget.stepMicros };
  // Production operator adapters: journaled commands (a retried command id never applies twice), revision checks,
  // views across every registered version and the fleet hold.
  const operator = createWorkflowOperatorTransports({ store, scope, journal: createWorkflowCommandJournal({ store, scope }), fleet,
    targets: [lifecycleOperatorTarget({ runtime, store, scope, definitions: [...workflows.definitions] })] });
  const settings = {
    agents: [
      { agent: desk.agent, permissions: { allow: [...desk.permissions] },
        limits: { maxSteps: 3, maxModelCalls: 2, maxToolCalls: 1, maxDurationMs: 60_000, maxCostMicros: config.budget.stepMicros } },
      ...team.map(member => ({ agent: member.agent, permissions: { allow: [...member.permissions] }, limits: agentLimits })),
    ],
    authenticate: authenticate(config, { desk: desk.agent.id, all: [desk.agent.id, ...team.map(member => member.agent.id)] }),
    // A retried submission after a restart is refused instead of starting a second desk run.
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
