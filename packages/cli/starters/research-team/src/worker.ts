import { hostname } from 'node:os';
import { createWorkflowLeadership, createWorkflowWorker } from '@mayura/workflows';
import { createWorkflowLifecycleHost } from '@mayura/workflows/lifecycle';
import type { Config } from './config.js';
import type { Services } from './services.js';

/**
 * The worker advances research runs: it plans, runs the researchers in parallel, writes and stores the report. Run as
 * many replicas as you like; leadership lets one advance the fleet at a time, and a crashed leader's lease expires
 * so another takes over. A step that was running when a process died is never repeated automatically.
 */
export function createResearchWorker(config: Config, services: Services, options: { readonly intervalMs?: number } = {}) {
  const host = createWorkflowLifecycleHost({ ...services.runtimeOptions, definitions: [...services.workflows.definitions],
    hold: services.fleet, intervalMs: options.intervalMs ?? 1_000, maxBackoffMs: 30_000 });
  const worker = createWorkflowWorker({ units: [host], leadership: createWorkflowLeadership({ store: services.store, scope: config.scope,
    role: 'research-worker', holderId: process.env['MAYURA_WORKER_ID'] ?? `${hostname()}-${process.pid}` }) });
  return { host, worker };
}
