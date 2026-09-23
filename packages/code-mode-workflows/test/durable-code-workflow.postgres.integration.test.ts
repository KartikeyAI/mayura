import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { Budget, type JsonValue, type Outcome, type Schema } from '@mayura/core';
import { createCodeMode, defineCodeProgram, defineSandboxAdapter } from '@mayura/code-mode';
import { defineTool, invokeTool } from '@mayura/tools';
import { createScheduledWorkflowRuntime } from '@mayura/workflows';
import { createPostgresStore } from '@mayura/storage';
import { createDurableCodeAudit, defineDurableCodeWorkflow } from '../src/index.js';

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
      const firstStore = createPostgresStore({ connectionString: connectionString!, schema }); stores.push(firstStore); await firstStore.initialize();
      const definitionFor = (store: typeof firstStore) => defineDurableCodeWorkflow({ id: 'pg.durable.code', version: '1', input: valueSchema,
        output: valueSchema, codeMode: mode, audit: createDurableCodeAudit({ store, scope: { principalId: 'pg-user', projectId: 'project' } }),
        phases: [{ id: 'execute', program, input: { kind: 'input' as const, path: [] } }], result: { kind: 'step' as const, stepId: 'execute', path: [] } });
      const definition = definitionFor(firstStore);
      const phase = definition.nodes[0]; if (!phase || phase.kind !== 'tool') throw new Error('Invalid fixture phase.');
      const options = { scope: { principalId: 'pg-user', projectId: 'project' }, permissions: { allow: [`tool:${phase.tool.id}`,
        ...phase.tool.capabilities] }, policyVersion: '1', maxCostMicros: 0, maxOutputBytes: 1_024,
        verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: true }) } as const;
      const first = createScheduledWorkflowRuntime({ ...options, store: firstStore, workerId: 'first' }); runtimes.push(first);
      const submitted = await first.submit(definition, { input: { value: 7 }, idempotencyKey: 'phase' });
      const waiting = await first.runUntilSettled(definition, submitted.id); const approval = waiting.steps['execute']!.approval!;
      expect(waiting.status).toBe('waiting'); expect(executions).toBe(0);
      await first.close(); runtimes.splice(0); await firstStore.close();
      const secondStore = createPostgresStore({ connectionString: connectionString!, schema }); stores.push(secondStore); await secondStore.initialize();
      const reopenedDefinition = definitionFor(secondStore); expect(reopenedDefinition.digest).toBe(definition.digest);
      const second = createScheduledWorkflowRuntime({ ...options, store: secondStore, workerId: 'second' }); runtimes.push(second);
      expect((await second.inspect(submitted.id)).steps['execute']!.approval).toEqual(approval);
      await second.approve({ id: submitted.id, nodeId: 'execute', digest: approval.digest, credential: 'trusted' });
      expect(await second.runUntilSettled(reopenedDefinition, submitted.id)).toMatchObject({ status: 'succeeded', output: { value: 7 } });
      expect(executions).toBe(1);
      expect(await createDurableCodeAudit({ store: secondStore, scope: options.scope }).inspect(submitted.id, 'execute'))
        .toMatchObject({ outcome: 'succeeded', evidence: [] });
    } finally {
      await Promise.all(runtimes.map(runtime => runtime.close())); await Promise.all(stores.map(store => store.close()));
      if (!/^mayura_code_phase_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected fixture schema.');
      const pool = new Pool({ connectionString: connectionString! });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    }
  });

  it.each(['effect', 'receipt', 'completion'] as const)('recovers without replay after a PostgreSQL process kill at the %s boundary', async scenario => {
    const schema = `mayura_code_phase_crash_${randomUUID().replaceAll('-', '')}`;
    const child = fork(fileURLToPath(new URL('./fixtures/durable-code-crash.mjs', import.meta.url)),
      [JSON.stringify({ adapter: 'postgres', schema, scenario })], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let exited = false; let runId: string | undefined;
    const exit = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); });
    const checkpoint = new Promise<{ readonly effects: number; readonly scenario: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned PostgreSQL Code Mode child did not reach its checkpoint.')), 12_000);
      child.once('error', reject);
      child.on('message', (message: { kind?: unknown; runId?: unknown; effects?: unknown; scenario?: unknown }) => {
        if (message.kind === 'run' && typeof message.runId === 'string') runId = message.runId;
        if (message.kind === 'checkpoint' && Number.isSafeInteger(message.effects) && typeof message.scenario === 'string') {
          clearTimeout(timer); resolve({ effects: message.effects as number, scenario: message.scenario });
        }
        if (message.kind === 'fixture-error') { clearTimeout(timer); reject(new Error('Owned PostgreSQL Code Mode child failed before its checkpoint.')); }
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Owned PostgreSQL Code Mode child exited before its checkpoint.')); });
    });
    const stores: ReturnType<typeof createPostgresStore>[] = [];
    const runtimes: ReturnType<typeof createScheduledWorkflowRuntime>[] = [];
    try {
      expect(await checkpoint).toEqual({ effects: 1, scenario }); expect(runId).toMatch(/^[a-f0-9]{64}$/u);
      child.kill('SIGKILL'); await exit; await new Promise(resolve => setTimeout(resolve, 1_050));
      let replayed = 0;
      const nested = defineTool({ id: 'external.crash-write', version: '1', description: 'Controlled crash write.', input: valueSchema,
        output: valueSchema, effects: 'write', capabilities: [], costMicros: 3, execute: input => { replayed++; return input; } });
      const limits = { cpuMillis: 100, wallTimeMillis: 120_000, memoryBytes: 16 * 1_024 * 1_024, scratchBytes: 1_024,
        maxInputBytes: 1_024, maxOutputBytes: 1_024, maxToolInputBytes: 1_024, maxToolCalls: 2, maxToolConcurrency: 1 };
      const program = defineCodeProgram({ id: 'crash.phase', version: '1', intent: 'Durable crash phase.', language: 'javascript',
        source: 'async (input, tools) => (await tools.call("external.crash-write", input)).output', input: valueSchema, output: valueSchema,
        inputSchemaId: 'crash.in', outputSchemaId: 'crash.out', tools: [nested], limits });
      const adapter = defineSandboxAdapter({ id: 'test.crash-phase-recovery-pg', version: '1', qualification: 'test', isAvailable: () => true,
        execute: async request => { replayed++; return { status: 'succeeded', output: request.input }; } });
      const budget = new Budget(3, 1);
      const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: (tool, input, context) => invokeTool(tool, input, {
        runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
        permissions: { allow: [`tool:${tool.id}`, 'effect:write'] }, budget,
      }) as Promise<Outcome<JsonValue>> });
      const store = createPostgresStore({ connectionString: connectionString!, schema }); stores.push(store); await store.initialize();
      const audit = createDurableCodeAudit({ store, scope: { principalId: 'crash-user', projectId: 'project' } });
      const definition = defineDurableCodeWorkflow({ id: 'crash.code', version: '1', input: valueSchema, output: valueSchema, codeMode: mode, audit,
        phases: [{ id: 'execute', program, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'execute', path: [] } });
      const phase = definition.nodes[0]; if (!phase || phase.kind !== 'tool') throw new Error('Invalid fixture phase.');
      const runtime = createScheduledWorkflowRuntime({ store, scope: { principalId: 'crash-user', projectId: 'project' },
        permissions: { allow: [`tool:${phase.tool.id}`, 'effect:write', ...phase.tool.capabilities] },
        policyVersion: '1', maxCostMicros: 6, maxOutputBytes: 1_024, workerId: 'recovery', leaseMs: 1_000,
        verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: true }) });
      runtimes.push(runtime);
      await runtime.recoverExpired(runId!);
      const recovered = await runtime.runUntilSettled(definition, runId!);
      if (scenario === 'completion') {
        expect(recovered).toMatchObject({ status: 'succeeded', output: { value: 1 },
          steps: { execute: { receipt: { execution: 'succeeded', disclosure: 'released' } } } });
      } else {
        expect(['outcome_unknown', 'blocked']).toContain(recovered.status); expect(recovered.output).toBeNull();
        if (scenario === 'receipt') expect(recovered.steps['execute']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      }
      const evidence = await audit.inspect(runId!, 'execute');
      if (scenario === 'effect') expect(evidence).toBeUndefined();
      else expect(evidence).toMatchObject({ outcome: 'succeeded', evidence: [{ receipt: { toolId: 'external.crash-write' } }] });
      await runtime.runUntilSettled(definition, runId!); expect(replayed).toBe(0);
    } finally {
      if (!exited) { child.kill('SIGKILL'); await exit; }
      await Promise.all(runtimes.map(runtime => runtime.close())); await Promise.all(stores.map(store => store.close()));
      if (!/^mayura_code_phase_crash_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected fixture schema.');
      const pool = new Pool({ connectionString: connectionString! });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    }
  }, 25_000);
});
