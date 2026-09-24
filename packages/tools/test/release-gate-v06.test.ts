import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget } from '@mayura/core';
import { batchOutput, defineTool, invokeBatch } from '../src/index.js';

const input = z.object({ value: z.number() });
const output = z.object({ result: z.number() });

describe('V06 tool batch semantics', () => {
  it('preserves mixed terminal, waiting and effect evidence without implying rollback', async () => {
    const effects: string[] = [];
    const success = defineTool({ id: 'v06.success', version: '1', description: 'Success fixture.', input, output, effects: 'none', capabilities: [], execute: value => ({ result: value.value }) });
    const denied = defineTool({ id: 'v06.denied', version: '1', description: 'Denied fixture.', input, output, effects: 'none', capabilities: [],
      guards: { input: [{ id: 'deny', check: () => ({ decision: 'block' as const }) }] }, execute: vi.fn(value => ({ result: value.value })) });
    const failure = defineTool({ id: 'v06.failure', version: '1', description: 'Failure fixture.', input, output, effects: 'none', capabilities: [], execute: () => { throw new Error('private pure failure'); } });
    const unknown = defineTool({ id: 'v06.unknown', version: '1', description: 'Unknown write fixture.', input, output, effects: 'write', capabilities: [], execute: () => { effects.push('unknown-write-started'); throw new Error('private remote response lost'); } });
    const withheld = defineTool({ id: 'v06.withheld', version: '1', description: 'Withheld write fixture.', input, output, effects: 'write', capabilities: [],
      guards: { output: [{ id: 'withhold', check: () => ({ decision: 'block' as const }) }] },
      execute: value => { effects.push('withheld-write-completed'); return { result: value.value }; } });
    const waitingExecute = vi.fn((value: { value: number }) => ({ result: value.value }));
    const waitingTool = defineTool({ id: 'v06.waiting', version: '1', description: 'Waiting fixture.', input, output, effects: 'write', capabilities: [], execute: waitingExecute });
    const consumer = defineTool({ id: 'v06.consumer', version: '1', description: 'Reference fixture.', input, output, effects: 'none', capabilities: [], execute: value => ({ result: value.value + 1 }) });
    const allow = [success, denied, failure, unknown, withheld, waitingTool, consumer].map(tool => `tool:${tool.id}`);

    const result = await invokeBatch([
      { id: 'success', tool: success, input: { value: 1 } },
      { id: 'denied', tool: denied, input: { value: 2 } },
      { id: 'waiting', tool: waitingTool, input: { value: 3 } },
      { id: 'failure', tool: failure, input: { value: 4 } },
      { id: 'unknown', tool: unknown, input: { value: 5 }, resources: ['remote-record'] },
      { id: 'withheld', tool: withheld, input: { value: 6 } },
      { id: 'reference', tool: consumer, input: { value: batchOutput<number>('success', ['result']) } },
      { id: 'wait-dependent', tool: consumer, input: { value: 8 }, dependsOn: ['waiting'] },
    ], {
      runId: 'v06-run', scope: { principalId: 'owner', projectId: 'project' }, signal: new AbortController().signal,
      permissions: { allow: [...allow, 'effect:write'] }, budget: new Budget(100, 32), concurrency: 8,
      admitCall: request => request.callId === 'waiting'
        ? { decision: 'waiting', reason: 'approval_required', waitId: 'approval:v06:waiting' }
        : { decision: 'allow' },
    });

    expect(result.map(item => item.outcome.status)).toEqual([
      'succeeded', 'blocked', 'waiting', 'failed', 'outcome_unknown', 'blocked', 'succeeded', 'waiting',
    ]);
    expect(result[1]?.outcome).toMatchObject({ receipt: { execution: 'not_started', disclosure: 'withheld' } });
    expect(result[2]?.outcome).toEqual({ status: 'waiting', reason: 'approval_required', waitId: 'approval:v06:waiting', dependencies: [],
      receipt: { callId: 'waiting', toolId: 'v06.waiting', execution: 'not_started', disclosure: 'withheld' } });
    expect(result[4]?.outcome).toMatchObject({ receipt: { execution: 'unknown', disclosure: 'withheld' } });
    expect(result[5]?.outcome).toMatchObject({ receipt: { execution: 'succeeded', disclosure: 'withheld' } });
    expect(result[6]?.outcome).toMatchObject({ status: 'succeeded', output: { result: 2 } });
    expect(result[7]?.outcome).toMatchObject({ status: 'waiting', reason: 'dependency_waiting', dependencies: ['waiting'], receipt: { execution: 'not_started' } });
    expect(waitingExecute).not.toHaveBeenCalled();
    expect(effects.sort()).toEqual(['unknown-write-started', 'withheld-write-completed']);
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
