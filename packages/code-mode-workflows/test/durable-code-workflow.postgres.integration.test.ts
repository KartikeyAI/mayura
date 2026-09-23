import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { type Schema } from '@mayura/core';
import { createCodeMode, defineCodeProgram, defineSandboxAdapter } from '@mayura/code-mode';
import { createScheduledWorkflowRuntime } from '@mayura/workflows';
import { createPostgresStore } from '@mayura/storage';
import { defineDurableCodeWorkflow } from '../src/index.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
const suite = connectionString ? describe : describe.skip;
type Value = { readonly value: number };
const valueSchema: Schema<Value, Value> = { '~standard': { version: 1, vendor: 'test', validate: value => value && typeof value === 'object'
  && typeof (value as { value?: unknown }).value === 'number' ? { value: value as Value } : { issues: [{ message: 'invalid' }] } } };

suite('PostgreSQL durable Code Mode workflow bridge', () => {
  it('retains exact program approval and executes once after close/reopen', async () => {
    const schema = `mayura_code_phase_${randomUUID().replaceAll('-', '')}`;
    const stores: ReturnType<typeof createPostgresStore>[] = [];
    const runtimes: ReturnType<typeof createScheduledWorkflowRuntime>[] = [];
    let executions = 0;
    try {
      const adapter = defineSandboxAdapter({ id: 'test.pg-phase', version: '1', qualification: 'test', isAvailable: () => true,
        execute: async request => { executions++; return { status: 'succeeded', output: request.input }; } });
      const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: async () => ({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'unused' } }) });
      const program = defineCodeProgram({ id: 'pg.phase', version: '1', intent: 'PostgreSQL durable phase.', language: 'javascript', source: 'input => input',
        input: valueSchema, output: valueSchema, inputSchemaId: 'in', outputSchemaId: 'out', limits: { cpuMillis: 100, wallTimeMillis: 2_000,
          memoryBytes: 16 * 1_024 * 1_024, scratchBytes: 1_024, maxInputBytes: 1_024, maxOutputBytes: 1_024,
          maxToolInputBytes: 1_024, maxToolCalls: 1, maxToolConcurrency: 1 } });
      const definition = defineDurableCodeWorkflow({ id: 'pg.durable.code', version: '1', input: valueSchema, output: valueSchema, codeMode: mode,
        phases: [{ id: 'execute', program, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'execute', path: [] } });
      const phase = definition.nodes[0]; if (!phase || phase.kind !== 'tool') throw new Error('Invalid fixture phase.');
      const options = { scope: { principalId: 'pg-user', projectId: 'project' }, permissions: { allow: [`tool:${phase.tool.id}`,
        'code:execute', `code:program:${program.manifest.digest}`] }, policyVersion: '1', maxCostMicros: 0, maxOutputBytes: 1_024,
        verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: true }) } as const;
      const firstStore = createPostgresStore({ connectionString: connectionString!, schema }); stores.push(firstStore); await firstStore.initialize();
      const first = createScheduledWorkflowRuntime({ ...options, store: firstStore, workerId: 'first' }); runtimes.push(first);
      const submitted = await first.submit(definition, { input: { value: 7 }, idempotencyKey: 'phase' });
      const waiting = await first.runUntilSettled(definition, submitted.id); const approval = waiting.steps['execute']!.approval!;
      expect(waiting.status).toBe('waiting'); expect(executions).toBe(0);
      await first.close(); runtimes.splice(0); await firstStore.close();
      const secondStore = createPostgresStore({ connectionString: connectionString!, schema }); stores.push(secondStore); await secondStore.initialize();
      const second = createScheduledWorkflowRuntime({ ...options, store: secondStore, workerId: 'second' }); runtimes.push(second);
      expect((await second.inspect(submitted.id)).steps['execute']!.approval).toEqual(approval);
      await second.approve({ id: submitted.id, nodeId: 'execute', digest: approval.digest, credential: 'trusted' });
      expect(await second.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'succeeded', output: { value: 7 } });
      expect(executions).toBe(1);
    } finally {
      await Promise.all(runtimes.map(runtime => runtime.close())); await Promise.all(stores.map(store => store.close()));
      if (!/^mayura_code_phase_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected fixture schema.');
      const pool = new Pool({ connectionString: connectionString! });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    }
  });
});

