import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { McpClient } from '@mayura/adapter-mcp';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createWorkflowFleetControl } from '@mayura/workflows';
import { createWorkflowLifecycleFleetRuntime, type WorkflowLifecycleFleetRuntime } from '@mayura/workflows/lifecycle';
import type { Config } from './config.js';
import { mcpHttpClient } from './mcp.js';
import { trackerTools } from './tracker-tools.js';
import { triageAgent, triagePhase } from './triage.js';
import { escalationFor, ticketWorkflows } from './workflows.js';

export interface ServiceOptions {
  /** Another MCP client for the tracker (default: Streamable HTTP to TRACKER_MCP_URL). */
  readonly tracker?: McpClient;
  /** Grants to withhold from both the triage agent and the workflow runtime. Tests use it; production leaves it empty. */
  readonly revoke?: readonly string[];
}

/** Storage and the pieces the server, the ingress and the worker share. All must use the same store, scope and definitions. */
export async function openServices(config: Config, options: ServiceOptions = {}) {
  let store;
  if (config.storage.kind === 'postgres') store = createPostgresStore({ connectionString: config.storage.connectionString });
  else {
    const filename = config.storage.filename === ':memory:' ? ':memory:' : resolve(config.storage.filename);
    if (filename !== ':memory:') await mkdir(dirname(filename), { recursive: true });
    store = createSqliteStore({ filename });
  }
  await store.initialize();

  // The tracker is reached only through MCP. The client connects lazily, on the first tool call.
  const ownClient = options.tracker ? undefined : mcpHttpClient({ url: config.tracker.url, ...(config.tracker.token ? { token: config.tracker.token } : {}) });
  const tools = trackerTools(options.tracker ?? ownClient!);
  let submissions: WorkflowLifecycleFleetRuntime | undefined;
  const triage = triageAgent({
    model: config.model, tools, maxRunCostMicros: config.maxRunCostMicros, ...(options.revoke ? { revoke: options.revoke } : {}),
    // Idempotent on the ticket: a second escalation request for the same ticket finds the run the first one started.
    escalate: async request => ({ runId: (await submissions!.submit(workflows.escalation, {
      idempotencyKey: `escalation:${request.ticketId}`, input: escalationFor(request, config.oncallAssignee) })).id }),
  });
  const workflows = ticketWorkflows({ tools, triage: triagePhase(triage), ...(options.revoke ? { revoke: options.revoke } : {}) });
  const runtimeOptions = { store, scope: config.scope, permissions: { allow: [...workflows.permissions] }, policyVersion: '1',
    maxCostMicros: config.maxRunCostMicros };
  // Submissions go through the fleet runtime so every run is indexed for the worker and the console.
  submissions = createWorkflowLifecycleFleetRuntime(runtimeOptions);
  // The durable fleet hold: operators can stop every worker from advancing runs, for example during an incident.
  const fleet = createWorkflowFleetControl({ store, scope: config.scope });
  return {
    store, workflows, triage, runtimeOptions, fleet, submissions,
    close: async () => { submissions?.close(); await ownClient?.close(); await store.close(); },
  };
}
export type Services = Awaited<ReturnType<typeof openServices>>;
