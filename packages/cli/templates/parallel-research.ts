import { agentAsTool, createRuntime, defineAgent } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { z } from 'zod';

const input = z.object({ topic: z.string() }); const finding = z.object({ finding: z.string() });
const child = (id: string, value: string) => defineAgent({ id, version: '1.0.0', instructions: 'Return one deterministic review finding.',
  input, output: finding, tools: [], model: scriptedModel([{ type: 'final', output: { finding: value }, usage: { costMicros: 0 } }]) });
const security = agentAsTool(child('research.security', 'security-reviewed'), { id: 'research.security-tool', description: 'Security review.',
  permissions: { allow: ['model:scripted'] }, limits: { maxCostMicros: 0 } });
const reliability = agentAsTool(child('research.reliability', 'reliability-reviewed'), { id: 'research.reliability-tool', description: 'Reliability review.',
  permissions: { allow: ['model:scripted'] }, limits: { maxCostMicros: 0 } });
const parent = defineAgent({ id: 'starter.parallel-research', version: '1.0.0', instructions: 'Run both required reviews and combine them.',
  input, output: z.object({ findings: z.array(z.string()).length(2) }), tools: [security, reliability], model: scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'security-1', toolId: security.id, input: { topic: 'Mayura' } },
      { id: 'reliability-1', toolId: reliability.id, input: { topic: 'Mayura' } }], usage: { costMicros: 0 } },
    { type: 'final', output: { findings: ['security-reviewed', 'reliability-reviewed'] }, usage: { costMicros: 0 } },
  ]) });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['agent:delegate', 'model:scripted',
  'tool:research.security-tool', 'tool:research.reliability-tool'] }, limits: { maxDescendantRuns: 2, maxDepth: 1, maxConcurrentOperations: 2 } });
try { console.log(JSON.stringify(await runtime.submit(parent, { input: { topic: 'Mayura' } }).result())); }
finally { await runtime.close(); }
