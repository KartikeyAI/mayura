import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Budget, type JsonValue, type Outcome, type Schema } from '@mayura/core';
import { createCodeMode, defineCodeProgram, defineSandboxAdapter } from '@mayura/code-mode';
import { defineTool, invokeTool } from '@mayura/tools';
import { createScheduledWorkflowRuntime } from '@mayura/workflows';
import { createSqliteStore } from '@mayura/storage';
import { createDurableCodeAudit, defineDurableCodeWorkflow } from '../src/index.js';

type Value = { readonly value: number };
const schema: Schema<Value, Value> = { '~standard': { version: 1, vendor: 'test', validate: value => value && typeof value === 'object'
  && typeof (value as { value?: unknown }).value === 'number' ? { value: value as Value } : { issues: [{ message: 'invalid' }] } } };
const limits = { cpuMillis: 100, wallTimeMillis: 2_000, memoryBytes: 16 * 1_024 * 1_024, scratchBytes: 1_024,
  maxInputBytes: 1_024, maxOutputBytes: 1_024, maxToolInputBytes: 1_024, maxToolCalls: 2, maxToolConcurrency: 1 };

describe('durable Code Mode workflow bridge', () => {
  it('persists exact approval before one brokered phase execution across reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mayura-code-phase-'));
    const filename = join(directory, 'state.sqlite');
    let executions = 0;
    try {
      const nested = defineTool({ id: 'external.write', version: '1', description: 'Controlled write.', input: schema, output: schema,
        effects: 'write', capabilities: [], costMicros: 3, execute: input => ({ value: input.value + 1 }) });
      const program = defineCodeProgram({ id: 'durable.phase', version: '1', intent: 'Durable phase fixture.', language: 'javascript',
        source: 'async (input, tools) => (await tools.call("external.write", input)).output', input: schema, output: schema,
        inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1', tools: [nested], limits });
      const adapter = defineSandboxAdapter({ id: 'test.durable-phase', version: '1', qualification: 'test', isAvailable: () => true,
        execute: async request => { executions++; const result = await request.tools.call('external.write', request.input);
          return result.status === 'succeeded' ? { status: 'succeeded', output: result.output } : { status: 'failed' }; } });
      const nestedBudget = new Budget(3, 1);
      const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: (tool, input, context) => invokeTool(tool, input, {
        runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
        permissions: { allow: [`tool:${tool.id}`, 'effect:write'] }, budget: nestedBudget,
      }) as Promise<Outcome<JsonValue>> });
      const firstStore = createSqliteStore({ filename }); await firstStore.initialize();
      const definitionFor = (store: typeof firstStore) => defineDurableCodeWorkflow({ id: 'durable.code', version: '1', input: schema,
        output: schema, codeMode: mode, audit: createDurableCodeAudit({ store, scope: { principalId: 'alice', projectId: 'project' } }),
        phases: [{ id: 'execute', program, input: { kind: 'input' as const, path: [] } }], result: { kind: 'step' as const, stepId: 'execute', path: [] } });
      const definition = definitionFor(firstStore);
      const phase = definition.nodes[0]!;
      expect(phase).toMatchObject({ kind: 'tool', approval: true });
      if (phase.kind !== 'tool') throw new Error('Expected phase tool.');
      expect(phase.tool).toMatchObject({ version: program.manifest.digest, effects: 'write', costMicros: 6 });
      expect(phase.tool.capabilities).toEqual(['code:execute', 'code:audit:v2', expect.stringMatching(/^code:audit-scope:[a-f0-9]{64}$/u),
        `code:program:${program.manifest.digest}`]);
      const policy = { scope: { principalId: 'alice', projectId: 'project' }, permissions: { allow: [`tool:${phase.tool.id}`, 'effect:write',
        ...phase.tool.capabilities] }, policyVersion: '1', maxCostMicros: 6, maxOutputBytes: 1_024,
        approvalTtlMs: 60_000, verifyHuman: async (credential: unknown) => {
          if (credential !== 'approved') throw new Error('denied'); return { id: 'reviewer', projectId: 'project', canApprove: true };
        } } as const;
      const first = createScheduledWorkflowRuntime({ ...policy, store: firstStore, workerId: 'first' });
      const submitted = await first.submit(definition, { input: { value: 2 }, idempotencyKey: randomUUID() });
      const waiting = await first.runUntilSettled(definition, submitted.id);
      expect(waiting).toMatchObject({ status: 'waiting', budget: { spentMicros: 0, reservedMicros: 0 } });
      expect(executions).toBe(0);
      const approval = waiting.steps['execute']!.approval!;
      await first.close(); await firstStore.close();

      const secondStore = createSqliteStore({ filename }); await secondStore.initialize();
      const reopenedDefinition = definitionFor(secondStore); expect(reopenedDefinition.digest).toBe(definition.digest);
      const second = createScheduledWorkflowRuntime({ ...policy, store: secondStore, workerId: 'second' });
      expect((await second.inspect(submitted.id)).steps['execute']!.approval).toEqual(approval);
      await expect(second.approve({ id: submitted.id, nodeId: 'execute', digest: 'a'.repeat(64), credential: 'approved' }))
        .rejects.toMatchObject({ code: 'CONFLICT' });
      await second.approve({ id: submitted.id, nodeId: 'execute', digest: approval.digest, credential: 'approved' });
      const completed = await second.runUntilSettled(reopenedDefinition, submitted.id);
      expect(completed).toMatchObject({ status: 'succeeded', output: { value: 3 }, budget: { spentMicros: 6, reservedMicros: 0 } });
      expect(completed.steps['execute']!.approval?.humanId).toBe('reviewer');
      expect(executions).toBe(1);
      expect((await second.runUntilSettled(reopenedDefinition, submitted.id)).status).toBe('succeeded');
      expect(executions).toBe(1);
      expect(await createDurableCodeAudit({ store: secondStore, scope: policy.scope }).inspect(submitted.id, 'execute')).toMatchObject({
        format: 2, runId: submitted.id, phaseId: 'execute', programDigest: program.manifest.digest, outcome: 'succeeded',
        usage: { toolCalls: 1, unknownCalls: 0, knownCostMicros: 3, unknownCostMicros: 0, maximumCostMicros: 6 },
        evidence: [{ runId: submitted.id, receipt: { toolId: 'external.write', execution: 'succeeded', disclosure: 'released' } }],
      });
      await second.close(); await secondStore.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects forged programs, executors, audits and accessor-bearing definitions', () => {
    const adapter = defineSandboxAdapter({ id: 'test.forgery', version: '1', qualification: 'test', isAvailable: () => true,
      execute: async () => ({ status: 'failed' }) });
    const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: vi.fn() });
    const program = defineCodeProgram({ id: 'genuine', version: '1', intent: 'Genuine.', language: 'javascript', source: 'input => input',
      input: schema, output: schema, inputSchemaId: 'in', outputSchemaId: 'out', limits });
    const fakeStore = { create: vi.fn(), read: vi.fn() } as unknown as Parameters<typeof createDurableCodeAudit>[0]['store'];
    const audit = createDurableCodeAudit({ store: fakeStore, scope: { principalId: 'alice', projectId: 'project' } });
    const base = { id: 'durable.code', version: '1', input: schema, output: schema, codeMode: mode, audit,
      phases: [{ id: 'phase', program, input: { kind: 'input' as const, path: [] } }], result: { kind: 'step' as const, stepId: 'phase', path: [] } };
    expect(() => defineDurableCodeWorkflow({ ...base, codeMode: { execute: mode.execute } })).toThrow();
    expect(() => defineDurableCodeWorkflow({ ...base, audit: { inspect: audit.inspect } })).toThrow();
    expect(() => defineDurableCodeWorkflow({ ...base, phases: [{ ...base.phases[0]!, program: { ...program } }] })).toThrow();
    expect(() => defineDurableCodeWorkflow(Object.defineProperty({ ...base }, 'phases', { enumerable: true, get: () => base.phases }))).toThrow();
    const oversized = defineCodeProgram({ id: 'too-many-calls', version: '1', intent: 'Rejected durable audit bound.', language: 'javascript',
      source: 'input => input', input: schema, output: schema, inputSchemaId: 'in', outputSchemaId: 'out',
      limits: { ...limits, maxToolCalls: 65 } });
    expect(() => defineDurableCodeWorkflow({ ...base, phases: [{ ...base.phases[0]!, program: oversized }] }))
      .toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });

  it('fails closed when an audit store returns a mismatched record identity', async () => {
    const fakeStore = ({ create: vi.fn(), read: vi.fn(async (_scope: string, id: string) => ({ scope: 'wrong', id,
      idempotencyKey: id, definitionHash: '0'.repeat(64), version: 1, state: {} })) }) as unknown as Parameters<typeof createDurableCodeAudit>[0]['store'];
    const audit = createDurableCodeAudit({ store: fakeStore, scope: { principalId: 'alice', projectId: 'project' } });
    await expect(audit.inspect('a'.repeat(64), 'execute')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('does not execute a phase when its durable audit belongs to another scope', async () => {
    const store = createSqliteStore({ filename: ':memory:' }); await store.initialize(); let executions = 0;
    const nested = defineTool({ id: 'external.scope-write', version: '1', description: 'Must not execute.', input: schema, output: schema,
      effects: 'write', capabilities: [], costMicros: 1, execute: input => { executions++; return input; } });
    const program = defineCodeProgram({ id: 'scope.phase', version: '1', intent: 'Audit scope isolation.', language: 'javascript',
      source: 'async (input, tools) => (await tools.call("external.scope-write", input)).output', input: schema, output: schema,
      inputSchemaId: 'in', outputSchemaId: 'out', tools: [nested], limits });
    const adapter = defineSandboxAdapter({ id: 'test.scope-phase', version: '1', qualification: 'test', isAvailable: () => true,
      execute: async request => { executions++; return { status: 'succeeded', output: request.input }; } });
    const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: vi.fn() });
    const audit = createDurableCodeAudit({ store, scope: { principalId: 'mallory', projectId: 'project' } });
    const definition = defineDurableCodeWorkflow({ id: 'scope.code', version: '1', input: schema, output: schema, codeMode: mode, audit,
      phases: [{ id: 'execute', program, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'execute', path: [] } });
    const phase = definition.nodes[0]; if (!phase || phase.kind !== 'tool') throw new Error('Invalid fixture phase.');
    const runtime = createScheduledWorkflowRuntime({ store, scope: { principalId: 'alice', projectId: 'project' },
      permissions: { allow: [`tool:${phase.tool.id}`, 'effect:write', ...phase.tool.capabilities] }, policyVersion: '1', maxCostMicros: 2,
      maxOutputBytes: 1_024, workerId: 'scope', verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: true }) });
    try {
      const submitted = await runtime.submit(definition, { input: { value: 1 }, idempotencyKey: 'scope' });
      const waiting = await runtime.runUntilSettled(definition, submitted.id);
      await runtime.approve({ id: submitted.id, nodeId: 'execute', digest: waiting.steps['execute']!.approval!.digest, credential: 'trusted' });
      expect(await runtime.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'outcome_unknown', output: null });
      expect(executions).toBe(0); expect(await audit.inspect(submitted.id, 'execute')).toBeUndefined();
    } finally { await runtime.close(); await store.close(); }
  });

  it('does not replay a write phase when its sandbox fails after the nested effect', async () => {
    const store = createSqliteStore({ filename: ':memory:' }); await store.initialize();
    let nestedWrites = 0; let sandboxRuns = 0;
    const nested = defineTool({ id: 'external.uncertain-write', version: '1', description: 'Controlled uncertain write.',
      input: schema, output: schema, effects: 'write', capabilities: [], costMicros: 3, execute: input => { nestedWrites++; return input; } });
    const program = defineCodeProgram({ id: 'uncertain.phase', version: '1', intent: 'No-replay fixture.', language: 'javascript',
      source: 'async (input, tools) => (await tools.call("external.uncertain-write", input)).output', input: schema, output: schema,
      inputSchemaId: 'in', outputSchemaId: 'out', tools: [nested], limits });
    const adapter = defineSandboxAdapter({ id: 'test.uncertain-phase', version: '1', qualification: 'test', isAvailable: () => true,
      execute: async request => { sandboxRuns++; await request.tools.call('external.uncertain-write', request.input); throw new Error('private crash'); } });
    const nestedBudget = new Budget(3, 1);
    const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: (tool, input, context) => invokeTool(tool, input, {
      runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
      permissions: { allow: [`tool:${tool.id}`, 'effect:write'] }, budget: nestedBudget,
    }) as Promise<Outcome<JsonValue>> });
    const audit = createDurableCodeAudit({ store, scope: { principalId: 'alice', projectId: 'project' } });
    const definition = defineDurableCodeWorkflow({ id: 'uncertain.code', version: '1', input: schema, output: schema, codeMode: mode, audit,
      phases: [{ id: 'execute', program, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'execute', path: [] } });
    const phase = definition.nodes[0]; if (!phase || phase.kind !== 'tool') throw new Error('Invalid fixture phase.');
    const runtime = createScheduledWorkflowRuntime({ store, scope: { principalId: 'alice', projectId: 'project' },
      permissions: { allow: [`tool:${phase.tool.id}`, 'effect:write', ...phase.tool.capabilities] },
      policyVersion: '1', maxCostMicros: 6, maxOutputBytes: 1_024, workerId: 'uncertain',
      verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: true }) });
    try {
      const submitted = await runtime.submit(definition, { input: { value: 1 }, idempotencyKey: 'uncertain' });
      const waiting = await runtime.runUntilSettled(definition, submitted.id);
      await runtime.approve({ id: submitted.id, nodeId: 'execute', digest: waiting.steps['execute']!.approval!.digest, credential: 'trusted' });
      const result = await runtime.runUntilSettled(definition, submitted.id);
      expect(result.status).toBe('outcome_unknown'); expect(result.output).toBeNull();
      expect(result.steps['execute']!.receipt).toMatchObject({ execution: 'unknown', disclosure: 'withheld' });
      expect(await audit.inspect(submitted.id, 'execute')).toMatchObject({ outcome: 'failed',
        usage: { toolCalls: 1, unknownCalls: 0, knownCostMicros: 3, unknownCostMicros: 0, maximumCostMicros: 6 },
        evidence: [{ receipt: { toolId: 'external.uncertain-write', execution: 'succeeded' } }] });
      await runtime.runUntilSettled(definition, submitted.id);
      expect({ sandboxRuns, nestedWrites }).toEqual({ sandboxRuns: 1, nestedWrites: 1 });
    } finally { await runtime.close(); await store.close(); }
  });

  it.each(['effect', 'receipt', 'completion'] as const)('recovers without replay after actual process termination at the %s boundary', async scenario => {
    const directory = await mkdtemp(join(tmpdir(), 'mayura-code-phase-crash-'));
    const filename = join(directory, 'state.sqlite');
    const child = fork(fileURLToPath(new URL('./fixtures/durable-code-crash.mjs', import.meta.url)), [JSON.stringify({ adapter: 'sqlite', filename, scenario })],
      { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let exited = false; let runId: string | undefined;
    const exit = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); });
    const checkpoint = new Promise<{ readonly effects: number; readonly scenario: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned Code Mode child did not reach its checkpoint.')), 8_000);
      child.once('error', reject);
      child.on('message', (message: { kind?: unknown; runId?: unknown; effects?: unknown; scenario?: unknown }) => {
        if (message.kind === 'run' && typeof message.runId === 'string') runId = message.runId;
        if (message.kind === 'checkpoint' && Number.isSafeInteger(message.effects) && typeof message.scenario === 'string') {
          clearTimeout(timer); resolve({ effects: message.effects as number, scenario: message.scenario });
        }
        if (message.kind === 'fixture-error') { clearTimeout(timer); reject(new Error('Owned Code Mode child failed before its checkpoint.')); }
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Owned Code Mode child exited before its checkpoint.')); });
    });
    try {
      expect(await checkpoint).toEqual({ effects: 1, scenario }); expect(runId).toMatch(/^[a-f0-9]{64}$/u);
      child.kill('SIGKILL'); await exit; await new Promise(resolve => setTimeout(resolve, 1_050));
      let replayed = 0;
      const nested = defineTool({ id: 'external.crash-write', version: '1', description: 'Controlled crash write.', input: schema, output: schema,
        effects: 'write', capabilities: [], costMicros: 3, execute: input => { replayed++; return input; } });
      const crashLimits = { ...limits, wallTimeMillis: 120_000 };
      const program = defineCodeProgram({ id: 'crash.phase', version: '1', intent: 'Durable crash phase.', language: 'javascript',
        source: 'async (input, tools) => (await tools.call("external.crash-write", input)).output', input: schema, output: schema,
        inputSchemaId: 'crash.in', outputSchemaId: 'crash.out', tools: [nested], limits: crashLimits });
      const adapter = defineSandboxAdapter({ id: 'test.crash-phase-recovery', version: '1', qualification: 'test', isAvailable: () => true,
        execute: async request => { replayed++; return { status: 'succeeded', output: request.input }; } });
      const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: vi.fn() });
      const store = createSqliteStore({ filename }); await store.initialize();
      const audit = createDurableCodeAudit({ store, scope: { principalId: 'crash-user', projectId: 'project' } });
      const definition = defineDurableCodeWorkflow({ id: 'crash.code', version: '1', input: schema, output: schema, codeMode: mode, audit,
        phases: [{ id: 'execute', program, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'execute', path: [] } });
      const phase = definition.nodes[0]; if (!phase || phase.kind !== 'tool') throw new Error('Invalid fixture phase.');
      const runtime = createScheduledWorkflowRuntime({ store, scope: { principalId: 'crash-user', projectId: 'project' },
        permissions: { allow: [`tool:${phase.tool.id}`, 'effect:write', ...phase.tool.capabilities] },
        policyVersion: '1', maxCostMicros: 6, maxOutputBytes: 1_024, workerId: 'recovery', leaseMs: 1_000,
        verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: true }) });
      try {
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
      } finally { await runtime.close(); await store.close(); }
    } finally {
      if (!exited) { child.kill('SIGKILL'); await exit; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
