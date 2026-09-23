import { Budget, type JsonValue, type Outcome, type Schema } from '@mayura/core';
import { defineTool, invokeTool } from '@mayura/tools';
import { createCodeMode, defineCodeProgram, defineSandboxAdapter } from '@mayura/code-mode';

type NumberValue = { readonly value: number };
const numberSchema: Schema<NumberValue, NumberValue> = {
  '~standard': { version: 1, vendor: 'fixture', validate: value => typeof value === 'object' && value !== null
    && typeof (value as NumberValue).value === 'number' ? { value: value as NumberValue } : { issues: [{ message: 'invalid' }] } },
};
const tool = defineTool({ id: 'number.double', version: '1', description: 'Double.', input: numberSchema, output: numberSchema,
  effects: 'none', capabilities: [], execute: input => ({ value: input.value * 2 }) });
const program = defineCodeProgram({ id: 'calculate', version: '1', intent: 'Calculate.', language: 'typescript', source: 'export default run;',
  input: numberSchema, output: numberSchema, inputSchemaId: 'number.input.v1', outputSchemaId: 'number.output.v1', tools: [tool],
  limits: { cpuMillis: 10, wallTimeMillis: 1_000, memoryBytes: 1_048_576, scratchBytes: 1_024, maxInputBytes: 1_024,
    maxOutputBytes: 1_024, maxToolInputBytes: 1_024, maxToolCalls: 1, maxToolConcurrency: 1 } });
const adapter = defineSandboxAdapter({ id: 'fixture', version: '1', qualification: 'test', isAvailable: () => true,
  execute: async request => { const outcome = await request.tools.call('number.double', request.input); return outcome.status === 'succeeded'
    ? { status: 'succeeded', output: outcome.output } : { status: 'failed' }; } });
const budget = new Budget(0, 1);
const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: (definition, input, context) => invokeTool(definition, input, {
  runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
  permissions: { allow: [`tool:${definition.id}`] }, budget,
}) as Promise<Outcome<JsonValue>> });
void mode.execute(program, { value: 2 }, { runId: 'run', executionId: 'execution', scope: { principalId: 'p', projectId: 'j' }, signal: new AbortController().signal })
  .then(result => result.usage.knownCostMicros);
// @ts-expect-error Credentials are not a Code Mode runtime option.
createCodeMode({ adapter, allowTestAdapter: true, invokeTool: async () => ({ status: 'failed', error: { code: 'TOOL_FAILED', message: '' } }), credentials: {} });
