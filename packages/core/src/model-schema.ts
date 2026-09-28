import { MayuraError } from './errors.js';
import { freezeJson, jsonValue, type JsonObject, type JsonValue } from './json.js';
import type { Schema } from './schema.js';
import { ModelProviderError, type ModelDefinitionCheck, type ModelFailureReason } from './contracts.js';

const nested = ['items', 'additionalItems', 'not', 'if', 'then', 'else', 'contains'] as const;
const lists = ['anyOf', 'allOf', 'oneOf', 'prefixItems'] as const;
const maps = ['$defs', 'definitions', 'properties', 'patternProperties'] as const;
const isObject = (value: JsonValue | undefined): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const describesObject = (node: JsonObject): boolean =>
  node['type'] === 'object' || (Array.isArray(node['type']) && node['type'].includes('object')) || (node['type'] === undefined && isObject(node['properties']));

/** Visit every subschema of a JSON Schema, with its JSON Pointer. */
function walk(node: JsonObject, path: string, visit: (node: JsonObject, path: string) => void): void {
  visit(node, path);
  for (const key of nested) { const child = node[key]; if (isObject(child)) walk(child, `${path}/${key}`, visit); }
  if (isObject(node['additionalProperties'])) walk(node['additionalProperties'], `${path}/additionalProperties`, visit);
  for (const key of lists) { const children = node[key]; if (Array.isArray(children)) children.forEach((child, index) => { if (isObject(child)) walk(child, `${path}/${key}/${index}`, visit); }); }
  for (const key of maps) {
    const children = node[key];
    if (isObject(children)) for (const [name, child] of Object.entries(children)) if (isObject(child)) walk(child, `${path}/${key}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`, visit);
  }
}

/**
 * The JSON Schema of the values a validator accepts, when the validator can describe itself through the Standard JSON
 * Schema interface (`~standard.jsonSchema`, which Zod 4.2 and later implement). That is what a model has to produce:
 * a tool's input, or an agent's output. The `$schema` dialect marker is removed, and an object that says nothing about
 * other keys gets `additionalProperties: false`, because a model should never add keys the validator would drop.
 * Returns undefined when the validator cannot describe itself, or its description is not plain bounded JSON.
 */
export function jsonSchemaOf(schema: Schema): JsonObject | undefined {
  let described: unknown;
  try {
    const standard = schema['~standard'] as { readonly jsonSchema?: { readonly input?: unknown } };
    const generator = standard.jsonSchema?.input;
    if (typeof generator !== 'function') return undefined;
    described = generator.call(standard.jsonSchema, { target: 'draft-2020-12' });
    // A plain copy: generators may attach non-enumerable metadata that is not JSON.
    const copy = jsonValue(JSON.parse(JSON.stringify(described)) as unknown, { maxBytes: 262_144, maxDepth: 64 });
    if (!isObject(copy)) return undefined;
    delete copy['$schema'];
    walk(copy, '', node => { if (describesObject(node) && node['additionalProperties'] === undefined) node['additionalProperties'] = false; });
    return freezeJson(copy) as JsonObject;
  } catch { return undefined; }
}

/**
 * Check a JSON Schema against the strict rules model providers apply to tool inputs and structured output (OpenAI and
 * Anthropic strict mode, and OpenAI-compatible servers): the root is an object, and every object lists all of its
 * properties in `required` and sets `additionalProperties: false`. Returns a frozen copy to send; an object with no
 * properties may leave out `properties` and `required`, which the copy states. Throws INVALID_CONFIG naming `subject`,
 * the place in the schema and how to fix it.
 */
export function strictJsonSchema(schema: unknown, subject: string): JsonObject {
  let copy: JsonValue;
  try { copy = jsonValue(schema, { maxBytes: 262_144, maxDepth: 64 }); }
  catch { throw new MayuraError('INVALID_CONFIG', `${subject} is not a plain JSON Schema object.`); }
  if (!isObject(copy) || copy['type'] !== 'object') throw new MayuraError('INVALID_CONFIG', `${subject} must be a JSON Schema whose root has type "object".`);
  const at = (path: string): string => (path ? ` at ${path}` : '');
  walk(copy, '', (node, path) => {
    if (!describesObject(node)) return;
    if (node['properties'] === undefined && node['required'] === undefined) node['properties'] = {};
    const properties = node['properties'];
    if (!isObject(properties)) throw new MayuraError('INVALID_CONFIG', `${subject}: "properties"${at(path)} must be an object.`);
    if (node['required'] === undefined && Object.keys(properties).length === 0) node['required'] = [];
    // Generators leave `required` out when nothing is required; then every property is optional.
    const required = node['required'] ?? [];
    if (!Array.isArray(required) || required.some(key => typeof key !== 'string') || new Set(required).size !== required.length) {
      throw new MayuraError('INVALID_CONFIG', `${subject}: "required"${at(path)} must list property names once each.`);
    }
    const optional = Object.keys(properties).find(key => !required.includes(key));
    if (optional !== undefined) {
      throw new MayuraError('INVALID_CONFIG', `${subject}: property "${optional}"${at(path)} is optional, but model providers require every property. Make it nullable instead (with Zod, .nullable() rather than .optional() or .default()).`);
    }
    const unknown = required.find(key => !Object.hasOwn(properties, key as string));
    if (unknown !== undefined) throw new MayuraError('INVALID_CONFIG', `${subject}: "required"${at(path)} names "${String(unknown)}", which is not a property.`);
    if (node['additionalProperties'] !== false) {
      throw new MayuraError('INVALID_CONFIG', `${subject}: the object${at(path)} must set additionalProperties to false; model providers accept no open objects, records or maps.`);
    }
  });
  return freezeJson(copy) as JsonObject;
}

/**
 * The failure for a provider's HTTP error status: 401 and 403 are credentials or model access, 402 and 429 a rate limit
 * or quota, 408 and 5xx the provider being unavailable, and any other status a rejected request. `costMicros` is usage
 * the provider confirmed before the failure, if any.
 */
export function providerHttpFailure(status: number, costMicros?: number): ModelProviderError {
  const reason: ModelFailureReason = status === 401 || status === 403 ? 'authentication' : status === 402 || status === 429 ? 'rate_limited'
    : status === 408 || (status >= 500 && status <= 599) ? 'unavailable' : 'rejected';
  const httpStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  return new ModelProviderError(reason, { ...(httpStatus === undefined ? {} : { httpStatus }), ...(costMicros === undefined ? {} : { costMicros }) });
}

/**
 * `ModelAdapter.checkDefinition` for a provider with strict schemas: every tool needs an input schema and the agent an
 * output schema (unless the adapter was given its own, `fixedOutput`), and each must follow the strict rules.
 */
export function checkStrictDefinition(definition: ModelDefinitionCheck, fixedOutput?: JsonObject): void {
  for (const tool of definition.tools) {
    if (tool.inputJsonSchema === undefined) {
      throw new MayuraError('INVALID_CONFIG', `Tool "${tool.id}" has no inputJsonSchema, and its input validator cannot describe itself. Give the tool an inputJsonSchema.`);
    }
    strictJsonSchema(tool.inputJsonSchema, `Tool "${tool.id}" input schema`);
  }
  if (fixedOutput !== undefined) return;
  if (definition.outputJsonSchema === undefined) {
    throw new MayuraError('INVALID_CONFIG', 'There is no output JSON Schema: the output validator cannot describe itself. Give outputJsonSchema to defineAgent or to the model adapter.');
  }
  strictJsonSchema(definition.outputJsonSchema, 'The output schema');
}
