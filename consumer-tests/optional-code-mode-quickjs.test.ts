import { Budget, type JsonValue, type Outcome, type Schema } from '@mayura/core';
import { defineTool, invokeTool } from '@mayura/tools';
import { createCodeMode, defineCodeProgram } from '@mayura/code-mode';
import { createQuickJsSandboxAdapter } from '@mayura/adapter-code-quickjs';

type Value = { readonly value: number };
const schema: Schema<Value, Value> = { '~standard': { version: 1, vendor: 'fixture', validate: value => value && typeof value === 'object'
  && typeof (value as Value).value === 'number' ? { value: value as Value } : { issues: [{ message: 'invalid' }] } } };
const tool = defineTool({ id: 'number.double', version: '1', description: 'Double.', input: schema, output: schema,
  effects: 'none', capabilities: [], execute: input => ({ value: input.value * 2 }) });
const program = defineCodeProgram({ id: 'quickjs.consumer', version: '1', intent: 'Packed adapter check.', language: 'javascript',
  source: 'async (input, tools) => (await tools.call("number.double", input)).output', input: schema, output: schema,
  inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1', tools: [tool], limits: { cpuMillis: 100,
    wallTimeMillis: 2_000, memoryBytes: 16_777_216, scratchBytes: 1_024, maxInputBytes: 1_024, maxOutputBytes: 1_024,
    maxToolInputBytes: 1_024, maxToolCalls: 1, maxToolConcurrency: 1 } });
const budget = new Budget(0, 1);
const mode = createCodeMode({ adapter: createQuickJsSandboxAdapter(), allowTestAdapter: true, invokeTool: (definition, input, context) =>
  invokeTool(definition, input, { runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
    permissions: { allow: [`tool:${definition.id}`] }, budget }) as Promise<Outcome<JsonValue>> });
void mode.execute(program, { value: 2 }, { runId: 'run', executionId: 'execution', scope: { principalId: 'p', projectId: 'j' }, signal: new AbortController().signal });
// @ts-expect-error The adapter accepts no ambient credential or host-client options.
createQuickJsSandboxAdapter({ credentials: {} });
