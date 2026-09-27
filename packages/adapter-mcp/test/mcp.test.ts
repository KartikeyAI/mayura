import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget } from '@mayura/core';
import { invokeTool } from '@mayura/tools';
import { defineMcpTool } from '../src/index.js';

const value = z.object({ value: z.number() });
const scope = { principalId: 'alice', projectId: 'project' };

function options(allow: readonly string[], callTool: (request: unknown) => Promise<unknown>) {
  const tool = defineMcpTool({ id: 'mcp.records.write', version: '1', description: 'Write one remote record.', remoteName: 'records/write',
    input: value, output: value, effects: 'write', capabilities: ['records:write'], costMicros: 2, client: { callTool } });
  return { tool, invocation: { runId: 'run', callId: crypto.randomUUID(), scope, signal: new AbortController().signal,
    permissions: { allow }, budget: new Budget(2, 1) } };
}

describe('MCP tool adapter', () => {
  it('uses the ordinary broker as the authority before any remote dispatch', async () => {
    const callTool = vi.fn(async (_request: unknown) => ({ structuredContent: { value: 2 } }));
    const { tool, invocation } = options(['tool:mcp.records.write', 'records:write'], callTool);
    await expect(invokeTool(tool, { value: 1 }, invocation)).resolves.toMatchObject({ status: 'blocked',
      error: { code: 'PERMISSION_DENIED' }, receipt: { execution: 'not_started', disclosure: 'withheld' } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('dispatches a bounded structured call only after admission', async () => {
    const callTool = vi.fn(async (_request: unknown) => ({ content: [], structuredContent: { value: 2 }, isError: false }));
    const { tool, invocation } = options(['tool:mcp.records.write', 'records:write', 'effect:write'], callTool);
    await expect(invokeTool(tool, { value: 1 }, invocation)).resolves.toMatchObject({ status: 'succeeded', output: { value: 2 },
      receipt: { toolId: 'mcp.records.write', execution: 'succeeded', disclosure: 'released' } });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]?.[0]).toMatchObject({ name: 'records/write', arguments: { value: 1 }, signal: expect.any(AbortSignal) });
    expect(Object.isFrozen(callTool.mock.calls[0]?.[0])).toBe(true);
  });

  it('accepts the protocol `_meta` field on a result without returning it', async () => {
    const callTool = vi.fn(async (_request: unknown) => ({ structuredContent: { value: 3 }, _meta: { 'example.com/trace': 'abc' } }));
    const { tool, invocation } = options(['tool:mcp.records.write', 'records:write', 'effect:write'], callTool);
    const outcome = await invokeTool(tool, { value: 1 }, invocation);
    expect(outcome).toMatchObject({ status: 'succeeded', output: { value: 3 } }); expect(JSON.stringify(outcome)).not.toContain('trace');
    const malformed = options(['tool:mcp.records.write', 'records:write', 'effect:write'], async () => ({ structuredContent: { value: 3 }, _meta: 'not an object' }));
    expect((await invokeTool(malformed.tool, { value: 1 }, malformed.invocation)).status).not.toBe('succeeded');
  });

  it('fails closed and sanitizes remote errors or malformed results', async () => {
    const failures: Array<(request: unknown) => Promise<unknown>> = [
      async () => { throw new Error('PRIVATE MCP TOKEN'); },
      async () => ({ content: [{ type: 'text', text: 'PRIVATE' }], isError: true }),
      async () => ({ structuredContent: Object.defineProperty({}, 'value', { enumerable: true, get: () => { throw new Error('PRIVATE'); } }) }),
    ];
    for (const failure of failures) {
      const callTool = vi.fn(failure);
      const { tool, invocation } = options(['tool:mcp.records.write', 'records:write', 'effect:write'], callTool);
      const outcome = await invokeTool(tool, { value: 1 }, invocation);
      expect(outcome).toMatchObject({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' }, receipt: { execution: 'unknown' } });
      expect(JSON.stringify(outcome)).not.toContain('PRIVATE');
    }
  });
});
