import { describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineWorkflow } from '../src/definition.js';
import { assertWorkflowLifecycle, defineWorkflowLifecycle, lifecycleManifest,
  type WorkflowLifecycleDefinition } from '../src/lifecycle.js';

const schema: Schema<JsonValue> = {
  '~standard': { version: 1, vendor: 'lifecycle-test', validate: value => ({ value: value as JsonValue }) },
};
const tool = defineTool({ id: 'fixture/read', version: '1', description: 'Read fixture data.', input: schema,
  output: schema, effects: 'read', capabilities: ['fixture:read'], costMicros: 1, execute: value => value });
const options = {
  id: 'review-lifecycle', version: '1', input: schema, output: schema,
  nodes: [
    { kind: 'tool' as const, id: 'draft', tool, input: { kind: 'input' as const, path: ['draft'] } },
    { kind: 'human' as const, id: 'review', dependsOn: ['draft'], request: {
      kind: 'correction' as const, schemaId: 'review/response', schemaDigest: 'a'.repeat(64),
      prompt: 'Review the draft.', response: schema,
      context: { kind: 'step' as const, stepId: 'draft', path: [] },
      subjectDigest: { kind: 'input' as const, path: ['digest'] },
    } },
    { kind: 'timer' as const, id: 'deadline', dependsOn: ['review'],
      fireAtMs: { kind: 'input' as const, path: ['deadlineAtMs'] } },
  ],
  result: { kind: 'step' as const, stepId: 'review', path: [] },
};

describe('workflow lifecycle public authoring contract', () => {
  it('creates a genuine immutable format-5 definition and data-only manifest', () => {
    const definition = defineWorkflowLifecycle(options); const manifest = lifecycleManifest(definition);
    expect(definition).toMatchObject({ format: 5, id: 'review-lifecycle' });
    expect(manifest).toMatchObject({ format: 5, graph: [{ kind: 'tool' }, { kind: 'human' }, { kind: 'timer' }] });
    expect(JSON.stringify(manifest)).not.toContain('validate');
    expect(definition.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(definition)).toBe(true); expect(Object.isFrozen(definition.nodes)).toBe(true);
    expect(Object.isFrozen(definition.nodes[1])).toBe(true);
    expect(() => assertWorkflowLifecycle({ ...definition })).toThrow();
  });

  it('uses a distinct digest domain from legacy workflows', () => {
    const lifecycle = defineWorkflowLifecycle({ ...options, nodes: [{ kind: 'join', id: 'done', dependsOn: [] }],
      result: { kind: 'literal', value: null } });
    const legacy = defineWorkflow({ ...options, nodes: [{ kind: 'join', id: 'done', dependsOn: [] }],
      result: { kind: 'literal', value: null } });
    expect(lifecycle.digest).not.toBe(legacy.digest);
  });

  it('owns binding arrays and schema wrappers rather than caller mutation', () => {
    const path = ['deadlineAtMs']; const dependencies = ['review'];
    const definition = defineWorkflowLifecycle({ ...options, nodes: [options.nodes[0]!, options.nodes[1]!,
      { kind: 'timer', id: 'deadline', dependsOn: dependencies, fireAtMs: { kind: 'input', path } }] });
    path.push('__proto__'); dependencies.push('deadline');
    expect(definition.nodes[2]).toMatchObject({ dependsOn: ['review'], fireAtMs: { path: ['deadlineAtMs'] } });
    expect((definition.nodes[1] as Extract<typeof definition.nodes[number], { kind: 'human' }>).request.response).not.toBe(schema);
  });

  it('rejects invalid lifecycle semantics before any execution is possible', () => {
    const human = options.nodes[1] as Extract<(typeof options.nodes)[number], { readonly kind: 'human' }>;
    expect(() => defineWorkflowLifecycle({ ...options, nodes: [options.nodes[0]!, {
      ...human, request: { ...human.request, subjectDigest: undefined },
    }] } as never)).toThrow();
    expect(() => defineWorkflowLifecycle({ ...options, nodes: [{ kind: 'timer', id: 'deadline', dependsOn: [],
      fireAtMs: { kind: 'step', stepId: 'review', path: [] } }] } as never)).toThrow();
  });

  it('requires the private definition brand at compile time', () => {
    if (false) {
      // @ts-expect-error Structural values cannot forge executable lifecycle definitions.
      const forged: WorkflowLifecycleDefinition = options;
      void forged;
    }
    expect(defineWorkflowLifecycle(options).format).toBe(5);
  });
});
