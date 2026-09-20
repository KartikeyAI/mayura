import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type StoredEvent } from './contracts.js';
import type { ScheduledWorkflowAggregateStore } from './scheduled-workflow-contracts.js';
import { workflowHashMaterial } from './workflow-format2.js';

/** Immutable scheduled-run identity, not an authorization capability or backend identity proof. */
export interface ExecutionRef {
  readonly kind: 'scheduled-workflow';
  readonly runId: string;
  readonly definitionHash: string;
  readonly policyHash: string;
}

/** A terminal observation contains no workflow payload, error, receipt or provider data. */
export interface ExecutionCompletion {
  readonly reference: ExecutionRef;
  readonly outcome: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
  readonly sourceVersion: number;
  readonly sourceEventSequence: number;
}

/** A finite all-target join. Initial states have version 1; later resolution/cancellation has 2. */
export interface ExecutionWaitSnapshot {
  readonly id: string;
  readonly version: number;
  readonly definitionHash: string;
  readonly status: 'waiting' | 'resolved' | 'cancelled';
  readonly targets: readonly ExecutionRef[];
  readonly observations: readonly ExecutionCompletion[];
}

/** Scope is the existing mayura:scope:v1 digest, not a caller-supplied principal record. */
export interface ExecutionWaitStreamKey {
  readonly scope: string;
  readonly streamId: string;
  readonly policyHash: string;
}
export interface ExecutionWaitKey extends ExecutionWaitStreamKey { readonly id: string }

/**
 * Finite trusted-host commands. There are no replacement-state updates, callbacks, clocks,
 * dispatches or per-wait pending promises. Cancellation affects only the wait, never its targets.
 */
export interface ExecutionWaitStore {
  initialize(): Promise<void>;
  open(command: ExecutionWaitStreamKey): Promise<void>;
  materialize(command: { readonly scope: string; readonly reference: ExecutionRef }): Promise<ExecutionCompletion | undefined>;
  register(command: ExecutionWaitKey & { readonly targets: readonly ExecutionRef[] }): Promise<ExecutionWaitSnapshot>;
  inspect(command: ExecutionWaitKey): Promise<ExecutionWaitSnapshot | undefined>;
  cancel(command: ExecutionWaitKey): Promise<ExecutionWaitSnapshot>;
  drainReady(command: ExecutionWaitStreamKey & { readonly limit: number }): Promise<readonly ExecutionWaitSnapshot[]>;
  events(command: ExecutionWaitStreamKey & { readonly after: number }): Promise<readonly StoredEvent[]>;
}

/** Explicit opt-in: existing scheduled/aggregate-only custom adapters are not widened. */
export interface ExecutionWaitAggregateStore extends ScheduledWorkflowAggregateStore {
  readonly executionWaits: ExecutionWaitStore;
}
export type ExecutionWaitMethod = keyof ExecutionWaitStore;

const MAX_BYTES = 65_536;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded execution-wait metadata.'); }
function record(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
function fields(value: JsonObject, names: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name))) invalid();
}
function hash(value: unknown): void { if (typeof value !== 'string' || !HASH.test(value)) invalid(); }
function identifier(value: unknown): void { if (typeof value !== 'string' || !ID.test(value)) invalid(); }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
}
/** Snapshot all caller data before inspecting it; never call caller-owned methods or iterators. */
function validated<T>(value: unknown, check: (copy: JsonObject) => void): T {
  try {
    const copy = record(jsonValue(value, { maxBytes: MAX_BYTES, maxDepth: 12, maxNodes: 8_192 }));
    check(copy);
    return freezeJson(copy) as unknown as T;
  } catch { return invalid(); }
}
function referenceFields(value: JsonObject): void {
  fields(value, ['kind', 'runId', 'definitionHash', 'policyHash']);
  if (value['kind'] !== 'scheduled-workflow') invalid();
  hash(value['runId']); hash(value['definitionHash']); hash(value['policyHash']);
}
function completionFields(value: JsonObject): void {
  fields(value, ['reference', 'outcome', 'sourceVersion', 'sourceEventSequence']);
  referenceFields(record(value['reference']));
  if (!['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(value['outcome'] as string)) invalid();
  integer(value['sourceVersion'], 1); integer(value['sourceEventSequence'], 1);
}
function targetFields(value: JsonValue | undefined, policyHash?: JsonValue, enforcePolicy = true): JsonObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) invalid();
  const ids = new Set<string>();
  let pinnedPolicy = policyHash;
  return value.map(item => {
    const target = record(item); referenceFields(target);
    if (pinnedPolicy === undefined) pinnedPolicy = target['policyHash'];
    if ((enforcePolicy && target['policyHash'] !== pinnedPolicy) || ids.has(target['runId'] as string)) invalid();
    ids.add(target['runId'] as string); return target;
  });
}
function sameReference(left: JsonObject, right: JsonObject): boolean {
  return ['kind', 'runId', 'definitionHash', 'policyHash'].every(field => left[field] === right[field]);
}
function snapshotFields(value: JsonObject): void {
  fields(value, ['id', 'version', 'definitionHash', 'status', 'targets', 'observations']);
  identifier(value['id']); hash(value['definitionHash']); integer(value['version'], 1, 2);
  const targets = targetFields(value['targets']);
  const observations = value['observations'];
  if (!Array.isArray(observations)) invalid();
  if (value['status'] === 'resolved') {
    if (observations.length !== targets.length) invalid();
    observations.forEach((item, index) => {
      const observation = record(item); completionFields(observation);
      if (!sameReference(record(observation['reference']), targets[index]!)) invalid();
    });
  } else {
    if (observations.length !== 0 || (value['status'] !== 'waiting' && value['status'] !== 'cancelled')) invalid();
    if (value['version'] !== (value['status'] === 'waiting' ? 1 : 2)) invalid();
  }
}
function streamFields(value: JsonObject): void {
  hash(value['scope']); identifier(value['streamId']); hash(value['policyHash']);
}

/** Validate and own an exact bounded, deeply frozen reference. */
export function executionRef(value: unknown): ExecutionRef { return validated(value, referenceFields); }
/** Validate an immutable terminal observation without inventing source history or success. */
export function executionCompletion(value: unknown): ExecutionCompletion { return validated(value, completionFields); }
/** Validate structural continuity; the configured host must separately verify the definition digest. */
export function executionWaitSnapshot(value: unknown): ExecutionWaitSnapshot { return validated(value, snapshotFields); }

/** Snapshot/validate a whole command before a driver queue or asynchronous operation sees it. */
export function executionWaitCommand(method: ExecutionWaitMethod, value: unknown): JsonObject {
  return validated<JsonObject>(value, copy => {
    if (method === 'initialize') { fields(copy, []); return; }
    if (method === 'materialize') {
      fields(copy, ['scope', 'reference']); hash(copy['scope']); referenceFields(record(copy['reference'])); return;
    }
    const common = ['scope', 'streamId', 'policyHash'];
    streamFields(copy);
    switch (method) {
      case 'open': fields(copy, common); return;
      case 'register':
        fields(copy, [...common, 'id', 'targets']); identifier(copy['id']);
        // Well-formed authorization/identity mismatches are authoritative storage CONFLICTs,
        // not malformed transport data; preserve them for that check before materialization.
        targetFields(copy['targets'], undefined, false); return;
      case 'inspect': case 'cancel': fields(copy, [...common, 'id']); identifier(copy['id']); return;
      case 'drainReady': fields(copy, [...common, 'limit']); integer(copy['limit'], 1, 32); return;
      case 'events': fields(copy, [...common, 'after']); integer(copy['after'], 0); return;
      default: invalid();
    }
  });
}

/** Canonical domain-separated hash input; drivers/hosts select their own SHA-256 implementation. */
export function executionWaitHashMaterial(key: ExecutionWaitStreamKey, id: string, targets: readonly ExecutionRef[]): string {
  const capturedKey = executionWaitCommand('open', key);
  const command = executionWaitCommand('register', { ...capturedKey, id, targets });
  targetFields(command['targets'], capturedKey['policyHash']);
  return workflowHashMaterial('mayura:execution-wait:v1', { format: 1, key: capturedKey, id: command['id']!, targets: command['targets']! });
}
