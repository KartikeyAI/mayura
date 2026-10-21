import { MayuraError, type JsonValue, type Permissions } from '@mayura/core';
import type { AgentDefinition } from './agent.js';
/** Rebuild authority from pinned host definitions, then narrow it to the grants saved at the approval boundary. */
export function restoreHandoff(origin: AgentDefinition, source: Permissions, path: readonly string[], saved: readonly string[]) {
  let agent = origin; let permissions = source;
  for (const target of path) {
    const edge = agent.handoffs?.find(edge => edge.agent.id === target);
    if (!edge || !permissions.allow.includes(`agent:${target}`)) throw new MayuraError('PERMISSION_DENIED', 'The saved handoff path is no longer authorized.');
    agent = edge.agent; permissions = edge.permissions;
  }
  return { agent, permissions: Object.freeze({ allow: Object.freeze(permissions.allow.filter(grant => saved.includes(grant))) }) };
}

/** Compare validated JSON semantically: schema property ordering is not an output transformation. */
export function sameHandoffOutput(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => sameHandoffOutput(item, right[index]!));
  const keys = Object.keys(left); return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameHandoffOutput(left[key]!, right[key]!));
}
