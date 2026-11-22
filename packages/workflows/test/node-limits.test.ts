import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKFLOW_MAX_NODES,
  MAX_WORKFLOW_NODES,
  workflowNodeLimit,
  type JsonValue,
  type Schema,
} from '@mayura/core';
import {
  assertWorkflowStateMatchesManifest,
  assertWorkflowGraphStateMatchesManifest,
  assertWorkflowLifecycleStateMatchesManifest,
  initialWorkflowState,
  initialWorkflowGraphState,
  initialWorkflowLifecycleState,
  workflowState,
  workflowGraphState,
  workflowLifecycleState,
} from '@mayura/storage-contracts';
import { defineWorkflow } from '../src/definition.js';
import { defineWorkflowGraph, graphManifest } from '../src/graph-definition.js';
import { defineWorkflowLifecycle, lifecycleManifest } from '../src/lifecycle-definition.js';
import { defineWorkflowTree, treeManifest } from '../src/children-definition.js';
import { scheduledManifest } from '../src/scheduled-helpers.js';
import { workflowNodeLimit as browserNodeLimit } from '../../client/src/workflow-limits.js';
import { workflowNodeLimitsFromEnv } from '@mayura/core/host';

const schema: Schema<JsonValue> = {
  '~standard': { version: 1, vendor: 'node-limit-test', validate: (value) => ({ value: value as JsonValue }) },
};
const hash = 'a'.repeat(64);
const nodes = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ kind: 'join' as const, id: `n${index}`, dependsOn: [] }));
const options = (count: number) => ({
  id: 'bounded',
  version: '1',
  input: schema,
  output: schema,
  nodes: nodes(count),
  result: { kind: 'input' as const, path: [] },
});

describe('configurable workflow graph admission', () => {
  it('keeps the dependency-free browser validator in parity with the core wire contract', () => {
    expect(browserNodeLimit()).toBe(DEFAULT_WORKFLOW_MAX_NODES);
    expect(browserNodeLimit(false)).toBe(workflowNodeLimit(false));
    for (let value = 1; value <= MAX_WORKFLOW_NODES; value++) expect(browserNodeLimit(value)).toBe(workflowNodeLimit(value));
    for (const value of [0,-1,513,NaN,Infinity,1.5,null,'256',{},[]]) {
      expect(() => workflowNodeLimit(value)).toThrow(); expect(() => browserNodeLimit(value)).toThrow();
    }
  });
  it('snapshots an explicit host environment opt-in and persists false rather than Infinity', () => {
    for (const value of [undefined,'','false','0']) expect(workflowNodeLimitsFromEnv({MAYURA_WORKFLOW_DISABLE_MAX_NODES:value})).toEqual({});
    for (const value of ['true','1']) {
      const settings=workflowNodeLimitsFromEnv({MAYURA_WORKFLOW_DISABLE_MAX_NODES:value});
      for (const factory of [defineWorkflow,defineWorkflowGraph,defineWorkflowLifecycle]) {
        const definition=factory({...options(1024),...settings});
        expect(definition.maxNodes).toBe(false);expect(definition.nodes).toHaveLength(1024);
      }
      const plain=scheduledManifest(defineWorkflow({...options(1024),...settings}));
      const state=initialWorkflowState(plain,null,hash,hash,0);
      expect(JSON.parse(JSON.stringify(state)).maxNodes).toBe(false);
      expect(workflowState({id:hash,state:state as never}).maxNodes).toBe(false);
      expect(defineWorkflowTree({...options(256),...settings}).maxNodes).toBe(false);
      expect(()=>defineWorkflowTree({...options(257),...settings})).toThrow();
    }
    expect(()=>workflowNodeLimitsFromEnv({MAYURA_WORKFLOW_DISABLE_MAX_NODES:'yes'})).toThrow();
  });
  it('keeps 128 as the default and requires an explicit bounded integer opt-in', () => {
    expect(DEFAULT_WORKFLOW_MAX_NODES).toBe(128);
    expect(MAX_WORKFLOW_NODES).toBe(512);
    for (const factory of [defineWorkflow, defineWorkflowGraph, defineWorkflowLifecycle, defineWorkflowTree]) {
      expect(factory(options(128)).maxNodes).toBeUndefined();
      expect(() => factory(options(129))).toThrow();
      expect(factory({ ...options(256), maxNodes: 256 }).nodes).toHaveLength(256);
      expect(() => factory({ ...options(257), maxNodes: 256 })).toThrow();
      for (const maxNodes of [0, -1, 1.5, NaN, Infinity, 513, null, '256']) {
        expect(() => factory({ ...options(1), maxNodes } as never)).toThrow();
      }
    }
    for (const factory of [defineWorkflow, defineWorkflowGraph, defineWorkflowLifecycle]) {
      expect(factory({ ...options(512), maxNodes: 512 }).nodes).toHaveLength(512);
    }
    // Tree-wide limits remain separate from the per-graph ceiling.
    expect(() => defineWorkflowTree({ ...options(257), maxNodes: 512 })).toThrow();
    expect(workflowNodeLimit()).toBe(128);
  });

  it('keeps legacy metadata byte-compatible and binds explicit limits into definition identity', () => {
    const legacy = defineWorkflow(options(1));
    const configured = defineWorkflow({ ...options(1), maxNodes: 256 });
    expect(scheduledManifest(legacy)).not.toHaveProperty('maxNodes');
    expect(scheduledManifest(configured)).toHaveProperty('maxNodes', 256);
    expect(legacy.digest).not.toBe(configured.digest);
    expect(treeManifest(defineWorkflowTree({ ...options(256), maxNodes: 256 }))).toHaveProperty('maxNodes', 256);
  });

  it.each([512, false] as const)('retains the configured ceiling across storage codecs and rejects missing or changed recovery metadata (%s)', (maxNodes) => {
    const plain = scheduledManifest(defineWorkflow({ ...options(512), maxNodes }));
    const graph = graphManifest(defineWorkflowGraph({ ...options(512), maxNodes }));
    const lifecycle = lifecycleManifest(defineWorkflowLifecycle({ ...options(512), maxNodes }));
    for (const [manifest, initial, decode, match] of [
      [plain, initialWorkflowState, workflowState, assertWorkflowStateMatchesManifest],
      [graph, initialWorkflowGraphState, workflowGraphState, assertWorkflowGraphStateMatchesManifest],
      [lifecycle, initialWorkflowLifecycleState, workflowLifecycleState, assertWorkflowLifecycleStateMatchesManifest],
    ] as const) {
      // Each profile has its own vocabulary; this fixture uses their common join-only subset.
      const state = initial(manifest as never, null, hash, hash, 0);
      const recovered = decode({ id: hash, state: state as never });
      expect(recovered.maxNodes).toBe(maxNodes);
      expect(Object.keys(recovered.steps)).toHaveLength(512);
      match(recovered as never, manifest as never);
      const { maxNodes: _limit, ...legacyState } = state;
      expect(() => decode({ id: hash, state: legacyState as never })).toThrow();
      expect(() => decode({ id: hash, state: { ...state, maxNodes: 513 } as never })).toThrow();
      expect(() => match(recovered as never, { ...manifest, maxNodes: 511 } as never)).toThrow();
    }
  });
});
