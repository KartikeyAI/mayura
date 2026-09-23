import { createCodeMode, defineCodeProgram, defineSandboxAdapter } from '@mayura/code-mode';
import { defineDurableCodeWorkflow } from '@mayura/code-mode-workflows';

const schema = { '~standard': { version: 1, vendor: 'fixture', validate: value => ({ value }) } };
const adapter = defineSandboxAdapter({ id: 'fixture', version: '1', qualification: 'test', isAvailable: () => true,
  execute: async request => ({ status: 'succeeded', output: request.input }) });
const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: async () => ({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'unused' } }) });
const program = defineCodeProgram({ id: 'phase', version: '1', intent: 'Packed phase.', language: 'javascript', source: 'input => input',
  input: schema, output: schema, inputSchemaId: 'in', outputSchemaId: 'out', limits: { cpuMillis: 10, wallTimeMillis: 1_000,
    memoryBytes: 1_048_576, scratchBytes: 1_024, maxInputBytes: 1_024, maxOutputBytes: 1_024, maxToolInputBytes: 1_024,
    maxToolCalls: 1, maxToolConcurrency: 1 } });
const workflow = defineDurableCodeWorkflow({ id: 'durable', version: '1', input: schema, output: schema, codeMode: mode,
  phases: [{ id: 'phase', program, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'phase', path: [] } });
const phase = workflow.nodes[0];
console.log(JSON.stringify({ status: phase?.kind === 'tool' && phase.approval === true && phase.tool.version === program.manifest.digest ? 'passed' : 'failed',
  mandatoryApproval: phase?.kind === 'tool' && phase.approval === true,
  programDigestPinned: phase?.kind === 'tool' && phase.tool.version === program.manifest.digest,
  driverFreeDefinition: true }));
