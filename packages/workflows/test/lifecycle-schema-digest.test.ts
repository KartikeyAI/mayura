import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MayuraError, type JsonValue, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineWorkflowLifecycle, lifecycleManifest, schemaDigest, type WorkflowLifecycleNode } from '../src/lifecycle.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'digest-test', validate: value => ({ value: value as JsonValue }) } };
const opaque: Schema<{ ok: boolean }> = { '~standard': { version: 1, vendor: 'digest-test', validate: value => ({ value: value as { ok: boolean } }) } };
const draft = defineTool({ id: 'digest/draft', version: '1', description: 'Draft.', input: any, output: any, effects: 'none', capabilities: [], execute: input => input });
const response = z.strictObject({ plan: z.enum(['online', 'maintenance-window']) });
const define = (request: Partial<Extract<WorkflowLifecycleNode, { kind: 'human' }>['request']>) => defineWorkflowLifecycle({
  id: 'digest', version: '1', input: any, output: any, result: { kind: 'step', stepId: 'pick', path: [] }, nodes: [
    { kind: 'tool', id: 'draft', tool: draft, input: { kind: 'input', path: [] } },
    { kind: 'human', id: 'pick', dependsOn: ['draft'], request: { kind: 'plan_selection', schemaId: 'digest/plan', prompt: 'Pick a plan.', response, ...request } },
  ] });
const pinned = (definition: ReturnType<typeof define>) => (lifecycleManifest(definition).graph[1] as { schemaDigest: string }).schemaDigest;

describe('human step schema digests', () => {
  it('derives the digest from a response validator that describes itself', () => {
    const derived = define({});
    expect(pinned(derived)).toBe(schemaDigest(response));
    expect((derived.nodes[1] as Extract<WorkflowLifecycleNode, { kind: 'human' }>).request.schemaDigest).toBe(schemaDigest(response));
    // The same derived digest gives the same definition; a different response contract gives a different one.
    expect(define({}).digest).toBe(derived.digest);
    expect(define({ response: z.strictObject({ plan: z.enum(['online']) }) }).digest).not.toBe(derived.digest);
  });

  it('keeps an explicit digest exactly, including for validators that cannot describe themselves', () => {
    const explicit = 'b'.repeat(64);
    expect(pinned(define({ schemaDigest: explicit }))).toBe(explicit);
    expect(pinned(define({ schemaDigest: explicit, response: opaque as never }))).toBe(explicit);
    // An explicit digest equal to the derived one is the same definition.
    expect(define({ schemaDigest: schemaDigest(response) }).digest).toBe(define({}).digest);
  });

  it('says what to do when the digest can neither be read nor derived', () => {
    const error = (() => { try { define({ response: opaque as never }); } catch (caught) { return caught; } return undefined; })();
    expect(error).toBeInstanceOf(MayuraError);
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/"pick" has no schemaDigest.*request\.schemaDigest/) });
    expect(() => define({ schemaDigest: 'not-a-digest' })).toThrow(MayuraError);
  });
});
