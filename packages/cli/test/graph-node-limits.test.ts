import { describe, expect, it } from 'vitest';
import { inspectWorkflow } from '../src/operations.js';

describe('operational workflow graph limits', () => {
  it.each([512, false] as const)('retains the declared ceiling and supports a wide dependency list (%s)', async (maxNodes) => {
    const id = 'a'.repeat(64);
    const count = maxNodes === false ? 513 : maxNodes;
    const nodes = Array.from({ length: count }, (_, index) => ({
      id: `n${index}`, kind: 'join', dependsOn: index === count - 1 ? Array.from({ length: count - 1 }, (_, parent) => `n${parent}`) : [],
    }));
    const view = { format: 5, definitionId: 'large', definitionVersion: '1', runId: id, revision: 1,
      status: 'running', maxNodes, nodes, steps: nodes.map(node => ({ id: node.id,kind: node.kind,status: 'pending' })) };
    const settings = (workflow: unknown) => ({ baseUrl: 'https://offline.example.test', token: () => 'fixture-token',
      fetch: async () => new Response(JSON.stringify({ workflow }), { headers: { 'content-type': 'application/json' } }) });
    const received = await inspectWorkflow(settings(view),id);
    expect(received.maxNodes).toBe(maxNodes); expect(received.nodes).toHaveLength(count);
    expect(received.nodes[count - 1]!.dependsOn).toHaveLength(count - 1);
    const { maxNodes: _limit,...legacy } = view;
    await expect(inspectWorkflow(settings(legacy),id)).rejects.toMatchObject({ code:'INVALID_OUTPUT' });
    await expect(inspectWorkflow(settings({ ...view,maxNodes:513 }),id)).rejects.toMatchObject({ code:'INVALID_OUTPUT' });
  });
});
