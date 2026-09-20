import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError } from './contracts.js';
import { executionRef, type ExecutionRef } from './execution-wait-contracts.js';
import type { WorkflowGraphAggregateStore } from './workflow-graph-contracts.js';

/** Continuation metadata, not a capability or a stable-snapshot token. */
export interface WorkflowGraphDiscoveryCursor {
  readonly format: 1;
  readonly scope: string;
  readonly policyHash: string;
  readonly afterId: string;
}
/** A currently nonterminal observation, never permission or a promise of dispatch readiness. */
export interface WorkflowGraphDiscoveryCandidate {
  readonly reference: ExecutionRef;
  readonly version: number;
  readonly status: 'running' | 'waiting';
}
export interface WorkflowGraphDiscoveryPage {
  readonly candidates: readonly WorkflowGraphDiscoveryCandidate[];
  readonly examined: number;
  readonly nextCursor: WorkflowGraphDiscoveryCursor | null;
}
export interface WorkflowGraphDiscoveryScan {
  readonly scope: string;
  readonly policyHash: string;
  readonly cursor: WorkflowGraphDiscoveryCursor | null;
  /** Bounds examined owners, including terminal rows that produce no candidate. */
  readonly limit: number;
}
export interface WorkflowGraphDiscoveryStore {
  initialize(): Promise<void>;
  scan(command: WorkflowGraphDiscoveryScan): Promise<WorkflowGraphDiscoveryPage>;
}
/** An explicitly selected extra capability; existing custom graph adapters are unchanged. */
export interface WorkflowGraphDiscoveryAggregateStore extends WorkflowGraphAggregateStore {
  readonly workflowGraphDiscovery: WorkflowGraphDiscoveryStore;
}
export type WorkflowGraphDiscoveryMethod = keyof WorkflowGraphDiscoveryStore;

const HASH = /^[a-f0-9]{64}$/;
function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded graph discovery metadata.'); }
function object(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(); return value;
}
function fields(value: JsonObject, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
}
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) invalid(); return value; }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(); return value;
}
function owned<T>(raw: unknown, check: (value: JsonObject) => void): T {
  try {
    const value = object(jsonValue(raw, { maxBytes: 65_536, maxNodes: 4_096, maxDepth: 12 }));
    check(value); return freezeJson(value) as unknown as T;
  } catch { return invalid(); }
}
function cursorFields(value: JsonObject, scope?: string, policy?: string): void {
  fields(value, ['format', 'scope', 'policyHash', 'afterId']);
  if (value['format'] !== 1) invalid();
  hash(value['scope']); hash(value['policyHash']); hash(value['afterId']);
  if ((scope !== undefined && value['scope'] !== scope) || (policy !== undefined && value['policyHash'] !== policy)) invalid();
}

/** Validate exact cursor shape without interpreting it as authorization. */
export function workflowGraphDiscoveryCursor(raw: unknown): WorkflowGraphDiscoveryCursor {
  return owned(raw, value => cursorFields(value));
}
/** Capture complete commands before queueing or awaiting any database operation. */
export function workflowGraphDiscoveryCommand(method: WorkflowGraphDiscoveryMethod, raw: unknown): JsonObject {
  return owned(raw, value => {
    if (method === 'initialize') { fields(value, []); return; }
    if (method !== 'scan') invalid();
    fields(value, ['scope', 'policyHash', 'cursor', 'limit']);
    const scope = hash(value['scope']); const policy = hash(value['policyHash']); integer(value['limit'], 1, 32);
    if (value['cursor'] !== null) cursorFields(object(value['cursor']), scope, policy);
  });
}
/** Enforce page bounds/order/context; the configured adapter remains the persistence authority. */
export function workflowGraphDiscoveryPage(raw: unknown, context: WorkflowGraphDiscoveryScan): WorkflowGraphDiscoveryPage {
  const command = workflowGraphDiscoveryCommand('scan', context);
  const scope = command['scope'] as string; const policy = command['policyHash'] as string; const limit = command['limit'] as number;
  const afterId = command['cursor'] === null ? '' : object(command['cursor'])['afterId'] as string;
  return owned(raw, value => {
    fields(value, ['candidates', 'examined', 'nextCursor']);
    const examined = integer(value['examined'], 0, limit);
    if (!Array.isArray(value['candidates']) || value['candidates'].length > examined) invalid();
    let lastId = afterId;
    for (const rawCandidate of value['candidates']) {
      const candidate = object(rawCandidate); fields(candidate, ['reference', 'version', 'status']);
      const reference = executionRef(candidate['reference']); integer(candidate['version'], 1);
      if (!['running', 'waiting'].includes(candidate['status'] as string)
        || reference.policyHash !== policy || reference.runId <= lastId) invalid();
      lastId = reference.runId;
    }
    // A full examined page always permits continuation; terminal owners can leave
    // the candidate array empty. A short page ends this non-snapshot sweep.
    if (examined === limit) {
      const cursor = object(value['nextCursor']); cursorFields(cursor, scope, policy);
      const next = cursor['afterId'] as string;
      if (next <= afterId || next < lastId) invalid();
      if (value['candidates'].length === examined && next !== lastId) invalid();
    } else if (value['nextCursor'] !== null) invalid();
  });
}
