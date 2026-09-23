import { Budget } from '@mayura/core';
import { defineTool, invokeTool } from '@mayura/tools';
import { createCodeMode, defineCodeProgram, defineSandboxAdapter } from '@mayura/code-mode';

const schema = { '~standard': { version: 1, vendor: 'fixture', validate: value => value && typeof value === 'object' && typeof value.value === 'number'
  ? { value } : { issues: [{ message: 'invalid' }] } } };
const tool = defineTool({ id: 'number.double', version: '1', description: 'Double.', input: schema, output: schema,
  effects: 'none', capabilities: [], execute: input => ({ value: input.value * 2 }) });
const limits = { cpuMillis: 10, wallTimeMillis: 1_000, memoryBytes: 1_048_576, scratchBytes: 1_024, maxInputBytes: 1_024,
  maxOutputBytes: 1_024, maxToolInputBytes: 1_024, maxToolCalls: 1, maxToolConcurrency: 1 };
const program = defineCodeProgram({ id: 'calculate', version: '1', intent: 'Calculate.', language: 'javascript', source: 'export default run;',
  input: schema, output: schema, inputSchemaId: 'number.input.v1', outputSchemaId: 'number.output.v1', tools: [tool], limits });
let mediatedToolCall = false;
const adapter = defineSandboxAdapter({ id: 'fixture', version: '1', qualification: 'test', isAvailable: () => true,
  execute: async request => { const outcome = await request.tools.call('number.double', request.input); return outcome.status === 'succeeded'
    ? { status: 'succeeded', output: outcome.output } : { status: 'failed' }; } });
const budget = new Budget(0, 1);
const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: (definition, input, context) => {
  mediatedToolCall = true;
  return invokeTool(definition, input, { runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
    permissions: { allow: [`tool:${definition.id}`] }, budget });
} });
const result = await mode.execute(program, { value: 4 }, { runId: 'run', executionId: 'execution', scope: { principalId: 'p', projectId: 'j' }, signal: new AbortController().signal });
let noHostFallback = false;
const unavailable = defineSandboxAdapter({ id: 'unavailable', version: '1', qualification: 'test', isAvailable: () => false,
  execute: async () => { throw new Error('must not execute'); } });
const unavailableResult = await createCodeMode({ adapter: unavailable, allowTestAdapter: true, invokeTool: async () => { throw new Error('must not call'); } })
  .execute(program, { value: 1 }, { runId: 'run', executionId: 'unavailable', scope: { principalId: 'p', projectId: 'j' }, signal: new AbortController().signal });
noHostFallback = unavailableResult.error?.code === 'UNSUPPORTED_PROFILE';
console.log(JSON.stringify({ status: result.status === 'succeeded' && result.output.value === 8 ? 'passed' : 'failed', noHostFallback,
  mediatedToolCall, usageReported: result.usage.toolCalls === 1 && result.usage.unknownCalls === 0 && result.usage.knownCostMicros === 0
    && result.usage.unknownCostMicros === 0 && result.usage.maximumCostMicros === 0,
  sandboxDependencyCount: 0 }));
