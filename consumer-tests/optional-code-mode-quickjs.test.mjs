import { Budget } from '@mayura/core';
import { defineTool, invokeTool } from '@mayura/tools';
import { createCodeMode, defineCodeProgram } from '@mayura/code-mode';
import { createQuickJsSandboxAdapter } from '@mayura/adapter-code-quickjs';

const schema = { '~standard': { version: 1, vendor: 'fixture', validate: value => value && typeof value === 'object' && typeof value.value === 'number'
  ? { value } : { issues: [{ message: 'invalid' }] } } };
const limits = { cpuMillis: 250, wallTimeMillis: 3_000, memoryBytes: 16_777_216, scratchBytes: 1_024, maxInputBytes: 1_024,
  maxOutputBytes: 1_024, maxToolInputBytes: 1_024, maxToolCalls: 1, maxToolConcurrency: 1 };
const tool = defineTool({ id: 'number.double', version: '1', description: 'Double.', input: schema, output: schema,
  effects: 'none', capabilities: [], execute: input => ({ value: input.value * 2 }) });
const make = (id, source, output = schema, overrideLimits = limits) => defineCodeProgram({ id, version: '1', intent: 'Packed adapter check.',
  language: 'javascript', source, input: schema, output, inputSchemaId: 'value.input.v1', outputSchemaId: `${id}.output.v1`, tools: [tool], limits: overrideLimits });
let mediatedToolCall = false;
const budget = new Budget(0, 1);
const mode = createCodeMode({ adapter: createQuickJsSandboxAdapter(), allowTestAdapter: true, invokeTool: (definition, input, context) => {
  mediatedToolCall = true;
  return invokeTool(definition, input, { runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
    permissions: { allow: [`tool:${definition.id}`] }, budget });
} });
const options = id => ({ runId: 'run', executionId: id, scope: { principalId: 'p', projectId: 'j' }, signal: new AbortController().signal });
const result = await mode.execute(make('tool', 'async (input, tools) => (await tools.call("number.double", input)).output'), { value: 4 }, options('tool'));
const textSchema = { '~standard': { version: 1, vendor: 'fixture', validate: value => value && typeof value === 'object' && typeof value.value === 'string'
  ? { value } : { issues: [{ message: 'invalid' }] } } };
const globals = await mode.execute(make('globals', '() => ({ value: [typeof process, typeof require, typeof fetch].join(",") })', textSchema), { value: 1 }, options('globals'));
const cpu = await mode.execute(make('cpu', '() => { while (true) {} }', schema, { ...limits, cpuMillis: 20 }), { value: 1 }, options('cpu'));
console.log(JSON.stringify({ status: result.status === 'succeeded' && result.output.value === 8 ? 'passed' : 'failed', childProcess: true,
  nodeGlobalsAbsent: globals.status === 'succeeded' && globals.output.value === 'undefined,undefined,undefined', mediatedToolCall,
  usageReported: result.usage.toolCalls === 1 && result.usage.unknownCalls === 0 && result.usage.unknownCostMicros === 0,
  cpuInterrupted: cpu.status === 'failed' }));
