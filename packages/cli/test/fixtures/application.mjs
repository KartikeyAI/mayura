// Test application for `mayura serve` / `mayura worker`: real SQLite storage, a lifecycle host under a
// leadership lease, and a production server in proxy mode on loopback. Configured by environment variables.
import { join } from 'node:path';
import { createSqliteStore } from '@mayura/storage';
import { defineAgent } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { listenProductionServer } from '@mayura/server-node';
import { createWorkflowLeadership, createWorkflowWorker } from '@mayura/workflows';
import { createWorkflowLifecycleHost, defineWorkflowLifecycle } from '@mayura/workflows/lifecycle';

const any = { '~standard': { version: 1, vendor: 'cli-fixture', validate: value => ({ value }) } };
const scope = { principalId: 'cli-fixture', projectId: 'application' };
const store = createSqliteStore({ filename: join(process.env.MAYURA_FIXTURE_DIRECTORY, 'application.sqlite') });
let initialized;
const ready = () => (initialized ??= store.initialize());
export const timer = defineWorkflowLifecycle({ id: 'cli.timer', version: '1', input: any, output: any,
  nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }], result: { kind: 'step', stepId: 'wake', path: [] } });

export default {
  async server() {
    await ready();
    const agent = defineAgent({ id: 'cli.agent', version: '1', instructions: 'Fixture.', input: any, output: any, tools: [],
      model: scriptedModel([{ type: 'final', output: null, usage: { costMicros: 0 } }]) });
    return listenProductionServer({ agents: [{ agent, permissions: { allow: ['model:scripted'] } }], authenticate: async () => null,
      publicOrigin: 'https://api.example.test', hostname: '127.0.0.1', port: 0, tls: { terminatedBy: 'proxy' }, shutdownGraceMs: 100 });
  },
  async worker() {
    await ready();
    const host = createWorkflowLifecycleHost({ store, scope, definitions: [timer], permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, intervalMs: 50 });
    const due = await host.runtime.submit(timer, { input: { fireAtMs: 0 }, idempotencyKey: 'due-now' });
    globalThis.mayuraFixtureRuntime = host.runtime; globalThis.mayuraFixtureRunId = due.id;
    return createWorkflowWorker({ units: [host], renewIntervalMs: 100,
      leadership: createWorkflowLeadership({ store, scope, role: 'lifecycle-host', holderId: process.env.MAYURA_FIXTURE_HOLDER ?? 'replica-1', leaseMs: 3_000 }) });
  },
  async migrate() { await ready(); return { schemaVersion: 1 }; },
  async shutdown() { globalThis.mayuraFixtureShutdown = true; await store.close(); },
};
