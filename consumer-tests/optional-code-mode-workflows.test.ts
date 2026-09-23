import type { Schema } from '@mayura/core';
import { createCodeMode, defineCodeProgram, defineSandboxAdapter } from '@mayura/code-mode';
import { defineDurableCodeWorkflow } from '@mayura/code-mode-workflows';

type Value = { readonly value: number };
const schema: Schema<Value, Value> = { '~standard': { version: 1, vendor: 'fixture', validate: value => value && typeof value === 'object'
  && typeof (value as { value?: unknown }).value === 'number' ? { value: value as Value } : { issues: [{ message: 'invalid' }] } } };
const adapter = defineSandboxAdapter({ id: 'fixture', version: '1', qualification: 'test', isAvailable: () => true,
  execute: async request => ({ status: 'succeeded', output: request.input }) });
const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: async () => ({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'unused' } }) });
const program = defineCodeProgram({ id: 'phase', version: '1', intent: 'Packed phase.', language: 'javascript', source: 'input => input',
  input: schema, output: schema, inputSchemaId: 'in', outputSchemaId: 'out', limits: { cpuMillis: 10, wallTimeMillis: 1_000,
    memoryBytes: 1_048_576, scratchBytes: 1_024, maxInputBytes: 1_024, maxOutputBytes: 1_024, maxToolInputBytes: 1_024,
    maxToolCalls: 1, maxToolConcurrency: 1 } });
const workflow = defineDurableCodeWorkflow({ id: 'durable', version: '1', input: schema, output: schema, codeMode: mode,
  phases: [{ id: 'phase', program, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'phase', path: [] } });
void workflow.digest;
defineDurableCodeWorkflow({ id: 'bad', version: '1', input: schema, output: schema, codeMode: mode,
  // @ts-expect-error Durable phase programs must be typed Code Program definitions.
  phases: [{ id: 'phase', program: {}, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'phase', path: [] } });
