import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchemaOf, MayuraError, type Schema } from '@mayura/core';
import { schemaDigest, sha256Hex } from '../src/schema-digest.js';
import { workflowHashMaterial } from '../src/workflow-format2.js';

describe('schema digests', () => {
  it('computes SHA-256 exactly as node:crypto does, across block boundaries and non-ASCII text', () => {
    const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(1_000),
      'Grüße, 世界 🌏', JSON.stringify({ nested: Array.from({ length: 300 }, (_, index) => index) })];
    for (const sample of samples) expect(sha256Hex(sample)).toBe(createHash('sha256').update(sample, 'utf8').digest('hex'));
  });

  it('derives the same digest from a validator and from its JSON Schema, whatever the key order', () => {
    const response = z.strictObject({ plan: z.enum(['online', 'maintenance-window']), note: z.string().max(200) });
    const described = jsonSchemaOf(response)!;
    const digest = schemaDigest(response);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(schemaDigest(described)).toBe(digest);
    const reordered = Object.fromEntries(Object.entries(described).reverse());
    expect(schemaDigest(reordered)).toBe(digest);
    expect(digest).toBe(sha256Hex(workflowHashMaterial('mayura:schema-digest:v1', described)));
    expect(schemaDigest(z.strictObject({ plan: z.enum(['online']) }))).not.toBe(digest);
  });

  it('refuses a validator that cannot describe itself, and values that are not JSON Schema objects', () => {
    const opaque: Schema<unknown> = { '~standard': { version: 1, vendor: 'opaque', validate: value => ({ value }) } };
    const error = (() => { try { schemaDigest(opaque); } catch (caught) { return caught; } return undefined; })();
    expect(error).toBeInstanceOf(MayuraError);
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/cannot describe itself/) });
    for (const bad of [null, [], 'schema', 7] as unknown[]) expect(() => schemaDigest(bad as never)).toThrow(MayuraError);
  });
});
