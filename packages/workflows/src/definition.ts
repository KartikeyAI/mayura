import { createHash } from 'node:crypto';
import { assertSchema, freezeJson, jsonValue, MayuraError, type InferInput, type InferOutput, type JsonObject, type JsonValue, type Schema } from '@mayura/core';
import { assertTool, type AnyTool } from '@mayura/tools';

export type Binding =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'input'; readonly path: readonly string[] }
  | { readonly kind: 'step'; readonly stepId: string; readonly path: readonly string[] };
export type WorkflowNode =
  | { readonly kind: 'tool'; readonly id: string; readonly tool: AnyTool; readonly input: Binding; readonly dependsOn?: readonly string[]; readonly approval?: boolean }
  | { readonly kind: 'join'; readonly id: string; readonly dependsOn: readonly string[] };
export interface WorkflowOptions<I extends Schema, O extends Schema> {
  readonly id: string; readonly version: string; readonly input: I; readonly output: O;
  readonly nodes: readonly WorkflowNode[]; readonly result: Binding;
}
export interface WorkflowDefinition<I extends Schema = Schema, O extends Schema = Schema> {
  readonly id: string; readonly version: string; readonly digest: string;
  readonly input: Schema<InferInput<I>, InferOutput<I>>;
  readonly output: Schema<InferInput<O>, InferOutput<O>>;
  readonly nodes: readonly WorkflowNode[]; readonly result: Binding;
}
export type AnyWorkflow = WorkflowDefinition;
export type WorkflowOutput<D extends AnyWorkflow> = InferOutput<D['output']>;
const identifier = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const definitions = new WeakSet<object>();

/** Mutable/forged definitions cannot enter the durable dispatcher. */
export function assertWorkflow(definition: AnyWorkflow): void {
  if (!definitions.has(definition)) throw new MayuraError('INVALID_CONFIG', 'Use defineWorkflow from this package instance.');
}

/** Canonical, sorted-key JSON encoding, domain-separated before SHA-256. */
export function digest(domain: string, value: unknown): string {
  function canonical(item: JsonValue): string {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key]!)}`).join(',')}}`;
  }
  return createHash('sha256').update(`${domain}\n${canonical(jsonValue(value))}`, 'utf8').digest('hex');
}

function checkedBinding(binding: Binding, ids: Set<string>): Binding {
  const value = jsonValue(binding);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('INVALID_CONFIG', 'Invalid workflow binding.');
  if (binding.kind === 'literal') jsonValue(binding.value);
  else if (binding.kind === 'input' || binding.kind === 'step') {
    if (!Array.isArray(binding.path) || binding.path.length > 32 || binding.path.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))) {
      throw new MayuraError('INVALID_CONFIG', 'Binding path must contain safe property names.');
    }
    if (binding.kind === 'step' && !ids.has(binding.stepId)) throw new MayuraError('INVALID_CONFIG', 'Binding references an unknown step.');
  } else throw new MayuraError('INVALID_CONFIG', 'Unknown binding kind.');
  return freezeJson(value) as unknown as Binding;
}

/** Define a finite acyclic graph. No user expression strings or callback stacks are persisted. */
export function defineWorkflow<I extends Schema, O extends Schema>(options: WorkflowOptions<I, O>): WorkflowDefinition<I, O> {
  if (!options || !identifier.test(options.id) || typeof options.version !== 'string' || !options.version.length || options.version.length > 128) throw new MayuraError('INVALID_CONFIG', 'Workflow id/version must be bounded identifiers.');
  assertSchema(options.input); assertSchema(options.output);
  if (!Array.isArray(options.nodes) || options.nodes.length === 0 || options.nodes.length > 128) throw new MayuraError('INVALID_CONFIG', 'A workflow requires 1–128 nodes.');
  const ids = new Set(options.nodes.map(node => node.id));
  if (ids.size !== options.nodes.length || [...ids].some(id => !identifier.test(id) || ['constructor', 'prototype', '__proto__'].includes(id))) throw new MayuraError('INVALID_CONFIG', 'Step identifiers must be unique and bounded.');
  const nodes = options.nodes.map(node => {
    if (node.kind !== 'join' && node.kind !== 'tool') throw new MayuraError('INVALID_CONFIG', 'Unknown workflow node kind.');
    const dependencies = [...(node.dependsOn ?? [])];
    if (new Set(dependencies).size !== dependencies.length || dependencies.some(id => !ids.has(id))) throw new MayuraError('INVALID_CONFIG', 'Invalid workflow dependencies.');
    if (node.kind === 'tool') {
      if (!node.tool || typeof node.tool.id !== 'string') throw new MayuraError('INVALID_CONFIG', 'A registered tool definition is required.');
      assertTool(node.tool);
      if (node.approval !== undefined && typeof node.approval !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'Approval configuration must be a boolean.');
      const binding = checkedBinding(node.input, ids);
      if (binding.kind === 'step' && !dependencies.includes(binding.stepId)) throw new MayuraError('INVALID_CONFIG', 'Step input must declare its output dependency.');
      return Object.freeze({ ...node, input: binding, dependsOn: Object.freeze(dependencies), approval: node.approval ?? false });
    }
    return Object.freeze({ ...node, dependsOn: Object.freeze(dependencies) });
  });
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new MayuraError('INVALID_CONFIG', 'Workflow dependency cycle detected.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of nodes.find(node => node.id === id)!.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  const result = checkedBinding(options.result, ids);
  const graph = nodes.map(node => node.kind === 'join'
    ? { id: node.id, kind: node.kind, dependsOn: node.dependsOn }
    : { id: node.id, kind: node.kind, dependsOn: node.dependsOn, tool: node.tool.id, toolVersion: node.tool.version, effects: node.tool.effects, capabilities: node.tool.capabilities, costMicros: node.tool.costMicros, approval: node.approval, input: node.input });
  const snapshot = <S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> => {
    const standard = schema['~standard'];
    return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor: standard.vendor, validate: standard.validate.bind(standard) }) }) as Schema<InferInput<S>, InferOutput<S>>;
  };
  const definition = Object.freeze({ id: options.id, version: options.version, digest: digest('mayura:workflow:v1', { id: options.id, version: options.version, graph, result }), input: snapshot(options.input), output: snapshot(options.output), nodes: Object.freeze(nodes), result });
  definitions.add(definition);
  return definition;
}

/** Read a binding from already admitted state without prototype traversal. */
export function resolveBinding(binding: Binding, input: JsonValue, outputs: Readonly<Record<string, JsonValue>>): JsonValue {
  if (binding.kind === 'literal') return jsonValue(binding.value);
  let value = binding.kind === 'input' ? input : outputs[binding.stepId];
  for (const segment of binding.path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) throw new MayuraError('INVALID_INPUT', 'Workflow binding cannot resolve its path.');
    value = (value as JsonObject)[segment];
  }
  return jsonValue(value);
}
