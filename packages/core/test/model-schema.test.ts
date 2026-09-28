import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Budget, jsonSchemaOf, MayuraError, modelFailureMessage, ModelProviderError, type Schema } from '../src/index.js';
import { checkStrictDefinition, providerHttpFailure, strictJsonSchema } from '../src/host.js';

describe('JSON Schemas for models', () => {
  it('describes a validator that can describe itself, closing objects and dropping the dialect marker', () => {
    const input = z.object({ city: z.string(), days: z.number().int().nullable(), stops: z.array(z.object({ name: z.string() })) });
    const schema = jsonSchemaOf(input)!;
    expect(schema['$schema']).toBeUndefined();
    expect(schema).toMatchObject({ type: 'object', required: ['city', 'days', 'stops'], additionalProperties: false,
      properties: { stops: { items: { type: 'object', additionalProperties: false } } } });
    expect(Object.isFrozen(schema)).toBe(true);
    expect(strictJsonSchema(schema, 'Input')).toEqual(schema);
    // What the model produces is the validator's input: a transform does not change it.
    expect(jsonSchemaOf(z.strictObject({ reply: z.string() }).transform(value => value.reply))).toMatchObject({ properties: { reply: { type: 'string' } } });
    const plain: Schema = { '~standard': { version: 1, vendor: 'plain', validate: value => ({ value }) } };
    expect(jsonSchemaOf(plain)).toBeUndefined();
    const broken = { '~standard': { version: 1, vendor: 'broken', validate: (value: unknown) => ({ value }), jsonSchema: { input: () => { throw new Error('no'); } } } } as Schema;
    expect(jsonSchemaOf(broken)).toBeUndefined();
  });

  it('checks the strict rules and says where and how to fix a schema', () => {
    const problem = (schema: unknown): string => { try { strictJsonSchema(schema, 'Tool "orders.find" input schema'); return 'accepted'; } catch (error) { return (error as MayuraError).message; } };
    expect(problem(jsonSchemaOf(z.object({ query: z.string().optional() })))).toBe('Tool "orders.find" input schema: property "query" is optional, but model providers require every property. Make it nullable instead (with Zod, .nullable() rather than .optional() or .default()).');
    expect(problem(jsonSchemaOf(z.object({ tags: z.record(z.string(), z.string()) })))).toContain('the object at /properties/tags must set additionalProperties to false');
    expect(problem({ type: 'string' })).toBe('Tool "orders.find" input schema must be a JSON Schema whose root has type "object".');
    expect(problem({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'b'], additionalProperties: false })).toContain('names "b", which is not a property');
    // A tool that takes nothing is strict as it stands; the copy states its empty lists.
    expect(strictJsonSchema({ type: 'object', additionalProperties: false }, 'x')).toEqual({ type: 'object', additionalProperties: false, properties: {}, required: [] });
  });

  it('checks a whole agent definition for a strict provider', () => {
    const tool = { id: 'orders.list', description: 'List.', inputJsonSchema: jsonSchemaOf(z.object({}))! };
    const output = jsonSchemaOf(z.object({ reply: z.string() }))!;
    expect(() => checkStrictDefinition({ tools: [tool], outputJsonSchema: output })).not.toThrow();
    expect(() => checkStrictDefinition({ tools: [{ id: 'orders.find', description: 'Find.' }], outputJsonSchema: output })).toThrow(/Tool "orders.find" has no inputJsonSchema/u);
    expect(() => checkStrictDefinition({ tools: [] })).toThrow(/no output JSON Schema/u);
    expect(() => checkStrictDefinition({ tools: [] }, output)).not.toThrow(); // the adapter has its own
  });
});

describe('model failures', () => {
  it('carry a reason whose message is Mayura\'s own, the HTTP status, and any confirmed cost', () => {
    const failure = providerHttpFailure(401);
    expect(failure).toMatchObject({ code: 'MODEL_FAILED', reason: 'authentication', httpStatus: 401, message: modelFailureMessage('authentication', 401) });
    expect(failure).not.toHaveProperty('costMicros'); expect(Object.isFrozen(failure)).toBe(true);
    expect(providerHttpFailure(429, 7)).toMatchObject({ reason: 'rate_limited', costMicros: 7 });
    expect(providerHttpFailure(529).reason).toBe('unavailable'); expect(providerHttpFailure(404).reason).toBe('rejected');
    expect(new ModelProviderError('configuration')).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(() => new ModelProviderError('whatever' as 'refused')).toThrow(/Unknown model failure reason/u);
    expect(() => new ModelProviderError('unavailable', { httpStatus: 42 })).toThrow(MayuraError);
  });

  it('say which budget limit stopped a call, and how to raise a budget of 0', () => {
    expect(() => new Budget(0, 4).reserve(1_000)).toThrow(/up to 1000 micros, but only 0 of the budget's 0 micros are left.*set limits.maxCostMicros/u);
    const budget = new Budget(1_500, 4); budget.reserve(1_000);
    expect(() => budget.reserve(1_000)).toThrow(/only 500 of the budget's 1500 micros are left; no new call was started\.$/u);
    const calls = new Budget(100, 1); calls.reserve(0);
    expect(() => calls.reserve(0)).toThrow(/call limit of 1 is used up/u);
  });
});
