import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, type JsonValue, type Outcome } from '@mayura/core';
import { defineTool, invokeBatch, invokeTool, type AnyTool } from '@mayura/tools';
import { agentAsTool, createRuntime, defineAgent, defineHook, type HookDefinition, type Runtime } from '@mayura/runtime';
import { scriptedModel } from '@mayura/testing';
import { defineWorkflow } from '@mayura/workflows';
import { workflowAsTool } from '@mayura/workflows/ephemeral';
import { createCodeMode, defineCodeProgram, defineSandboxAdapter } from '@mayura/code-mode';
import { defineMcpTool } from '@mayura/adapter-mcp';

const value = z.object({ value: z.number() });
const scope = { principalId: 'v01-owner', projectId: 'v01-project' };
const runtimes: Runtime[] = [];
const baseGrants = ['model:v01.parent', 'model:v01.child', 'model:mayura.workflow', 'agent:delegate',
  'tool:v01.read', 'tool:v01.delegate', 'tool:v01.workflow', 'tool:v01.mcp', 'records:read'];
const call = (toolId: string) => ({ type: 'tool_calls' as const, calls: [{ id: crypto.randomUUID(), toolId, input: { value: 1 } }], usage: { costMicros: 0 } });
const final = { type: 'final' as const, output: { value: 1 }, usage: { costMicros: 0 } };

function runtime(): Runtime {
  const selected = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: baseGrants },
    limits: { maxDurationMs: 2_000, maxCostMicros: 100, maxToolCalls: 16, maxModelCalls: 16, maxHookCalls: 4 } });
  runtimes.push(selected);
  return selected;
}

function agent(id: string, modelId: string, responses: Parameters<typeof scriptedModel>[0], tools: readonly AnyTool[] = [], hooks: readonly HookDefinition[] = []) {
  return defineAgent({ id, version: '1', instructions: 'Execute the deterministic V01 fixture.', input: value, output: value,
    model: scriptedModel(responses, { id: modelId }), tools, hooks });
}

afterEach(async () => { await Promise.all(runtimes.splice(0).map(item => item.close())); });

function code(outcome: Outcome<unknown>): string | undefined { return 'error' in outcome ? outcome.error.code : undefined; }

describe('V01 unified authority', () => {
  it('returns the same denial and performs zero effects across every invocation path', async () => {
    const execute = vi.fn((input: { value: number }) => input);
    const target = defineTool({ id: 'v01.read', version: '1', description: 'Protected read.', input: value, output: value,
      effects: 'read', capabilities: [], execute });
    const decisions: Record<string, string | undefined> = {};
    const invocation = (callId: string) => ({ runId: 'v01', callId, scope, signal: new AbortController().signal,
      permissions: { allow: baseGrants }, budget: new Budget(100, 16) });

    const direct = await invokeTool(target, { value: 1 }, invocation('direct'));
    decisions['direct'] = code(direct);

    try {
      await invokeBatch([{ id: 'batch', tool: target, input: { value: 1 } }], {
        runId: 'v01-batch', scope, signal: new AbortController().signal, permissions: { allow: baseGrants },
        budget: new Budget(100, 16), concurrency: 1,
      });
    } catch (error) { decisions['batch'] = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined; }

    const child = agent('v01.child', 'v01.child', [call('v01.read')], [target]);
    const delegated = agentAsTool(child, { id: 'v01.delegate', description: 'Delegated protected read.',
      permissions: { allow: [...baseGrants, 'effect:read'] } });
    const delegatedOutcome = await runtime().submit(agent('v01.delegate-parent', 'v01.parent', [call('v01.delegate')], [delegated]), { input: { value: 1 } }).result();
    decisions['delegated'] = code(delegatedOutcome);

    const definition = defineWorkflow({ id: 'v01.workflow', version: '1', input: value, output: value,
      nodes: [{ kind: 'tool', id: 'protected', tool: target, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'protected', path: [] } });
    const workflow = workflowAsTool(definition, { profile: 'ephemeral', id: 'v01.workflow', description: 'Protected workflow.',
      permissions: { allow: [...baseGrants, 'effect:read'] } });
    const workflowOutcome = await runtime().submit(agent('v01.workflow-parent', 'v01.parent', [call('v01.workflow')], [workflow]), { input: { value: 1 } }).result();
    decisions['workflow'] = code(workflowOutcome);

    const hook = defineHook({ id: 'v01.hook', version: '1', stage: 'beforeExecution', tools: [target],
      handler: () => ({ decision: 'continue', actions: [{ toolId: target.id, input: { value: 1 } }] }) });
    const hookOutcome = await runtime().submit(agent('v01.hook-agent', 'v01.parent', [final], [], [hook]), { input: { value: 1 } }).result();
    decisions['hook'] = code(hookOutcome);

    const remote = vi.fn(async (_request: unknown) => ({ structuredContent: { value: 1 } }));
    const mcp = defineMcpTool({ id: 'v01.mcp', version: '1', description: 'Protected MCP read.', remoteName: 'records/read',
      input: value, output: value, effects: 'read', capabilities: ['records:read'], client: { callTool: remote } });
    const mcpOutcome = await invokeTool(mcp, { value: 1 }, invocation('mcp'));
    decisions['mcp'] = code(mcpOutcome);

    const sandbox = defineSandboxAdapter({ id: 'v01.sandbox', version: '1', qualification: 'test', isAvailable: () => true,
      execute: async request => {
        const outcome = await request.tools.call(target.id, request.input);
        decisions['code-mode'] = outcome.error?.code;
        return { status: 'failed' as const };
      } });
    const broker = (tool: AnyTool, input: JsonValue, context: { runId: string; callId: string; scope: typeof scope; signal: AbortSignal }): Promise<Outcome<JsonValue>> =>
      invokeTool(tool, input, { runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
        permissions: { allow: baseGrants }, budget: new Budget(100, 16) }) as Promise<Outcome<JsonValue>>;
    const mode = createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: broker });
    const program = defineCodeProgram({ id: 'v01.code', version: '1', intent: 'Attempt the protected read.', language: 'javascript',
      source: 'async (input, tools) => (await tools.call("v01.read", input)).output', input: value, output: value,
      inputSchemaId: 'v01.input', outputSchemaId: 'v01.output', tools: [target], limits: { cpuMillis: 100, wallTimeMillis: 1_000,
        memoryBytes: 32 * 1_024 * 1_024, scratchBytes: 1_024, maxInputBytes: 1_024, maxOutputBytes: 1_024,
        maxToolInputBytes: 1_024, maxToolCalls: 1, maxToolConcurrency: 1 } });
    await mode.execute(program, { value: 1 }, { runId: 'v01-code', executionId: 'v01-code', scope, signal: new AbortController().signal });

    expect(decisions).toEqual({ direct: 'PERMISSION_DENIED', batch: 'PERMISSION_DENIED', delegated: 'PERMISSION_DENIED',
      workflow: 'PERMISSION_DENIED', hook: 'PERMISSION_DENIED', mcp: 'PERMISSION_DENIED', 'code-mode': 'PERMISSION_DENIED' });
    expect(execute).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });
});
