import { createHash } from 'node:crypto';
import { MayuraError, freezeJson, jsonValue, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import type { MemoryCategory, MemoryEntry, MemoryProvenance, MemoryRecord, MemorySensitivity, MemoryValidity } from './contracts.js';

export const MAX_RECORDS = 128;
export const MAX_AGGREGATE_BYTES = 786_432;
export const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const;
const categories = ['fact', 'preference', 'decision', 'procedure', 'episode'] as const;

export function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0') || Buffer.byteLength(value) > maxBytes) throw new MayuraError('INVALID_INPUT', `${label} must be a bounded nonempty string without null characters.`);
  return value;
}
export function memoryId(value: unknown): string {
  const id = text(value, 'Memory ID', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) throw new MayuraError('INVALID_INPUT', 'Memory ID must use a safe stable identifier.');
  return id;
}
export function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new MayuraError('INVALID_INPUT', `${label} must be a positive safe integer.`);
  return value;
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new MayuraError('INVALID_INPUT', 'Timestamps must be canonical UTC ISO strings.');
  return value;
}
export function object(value: unknown, maxBytes = 16_384, maxDepth = 12, maxNodes = 10_000): JsonObject {
  let result: JsonValue;
  try { result = jsonValue(value, { maxBytes, maxDepth, maxNodes }); }
  catch { throw new MayuraError('INVALID_INPUT', 'Memory data must be bounded plain JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new MayuraError('INVALID_INPUT', 'Memory data must be a JSON object.');
  return result;
}
export function exactKeys(value: JsonObject, keys: readonly string[]): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new MayuraError('INVALID_INPUT', 'Memory record fields do not match the supported format.');
}
export function allowedKeys(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new MayuraError('INVALID_INPUT', 'Memory input contains an unsupported field.');
}
export function sha256(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }
export function sensitivity(value: unknown): MemorySensitivity {
  if (!SENSITIVITIES.includes(value as MemorySensitivity)) throw new MayuraError('INVALID_INPUT', 'Unknown memory sensitivity.');
  return value as MemorySensitivity;
}

export function provenance(value: unknown): MemoryProvenance {
  const source = object(value, 4_096, 3);
  exactKeys(source, ['sourceId', 'reference', 'revision', 'sha256', 'author', 'observedAt', 'origin', 'confidence']);
  if (typeof source['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(source['sha256'])) throw new MayuraError('INVALID_INPUT', 'Source SHA-256 must contain 64 lowercase hexadecimal characters.');
  if (source['origin'] !== 'observed' && source['origin'] !== 'inferred') throw new MayuraError('INVALID_INPUT', 'Memory origin must be observed or inferred.');
  if (typeof source['confidence'] !== 'number' || !Number.isFinite(source['confidence']) || source['confidence'] < 0 || source['confidence'] > 1) throw new MayuraError('INVALID_INPUT', 'Memory confidence must be between zero and one.');
  return {
    sourceId: text(source['sourceId'], 'Source ID', 256), reference: text(source['reference'], 'Source reference', 1_024),
    revision: text(source['revision'], 'Source revision', 128), sha256: source['sha256'],
    author: text(source['author'], 'Source author', 256), observedAt: timestamp(source['observedAt']), origin: source['origin'], confidence: source['confidence'],
  };
}

export function validity(value: unknown, observedAt: string): MemoryValidity {
  const interval = value === undefined ? { from: observedAt, until: null } : object(value, 256, 2);
  exactKeys(interval, ['from', 'until']);
  const from = timestamp(interval['from']); const until = interval['until'] === null ? null : timestamp(interval['until']);
  if (until !== null && Date.parse(until) <= Date.parse(from)) throw new MayuraError('INVALID_INPUT', 'Memory validity must end after it begins.');
  return { from, until };
}

export function activeRecord(input: JsonObject, scope: Scope, version: number, createdAt: string, updatedAt: string): MemoryRecord {
  const source = provenance(input['provenance']);
  const category = input['category'] ?? 'fact';
  if (!categories.includes(category as MemoryCategory)) throw new MayuraError('INVALID_INPUT', 'Unknown memory category.');
  const content = text(input['content'], 'Memory content', 4_096);
  return {
    id: memoryId(input['id']), version, status: 'active', scope: { ...scope }, category: category as MemoryCategory,
    content, contentSha256: sha256(content), metadata: object(input['metadata'] ?? {}, 2_048, 8),
    sensitivity: sensitivity(input['sensitivity'] ?? 'internal'), provenance: source,
    validity: validity(input['validity'], source.observedAt), createdAt, updatedAt,
  };
}

export function parseEntry(raw: unknown, scope: Scope): MemoryEntry {
  const item = object(raw);
  const identity = ['id', 'version', 'status', 'scope', 'sensitivity', 'createdAt', 'updatedAt'];
  const owner = object(item['scope'], 512, 2); exactKeys(owner, ['principalId', 'projectId']);
  if (owner['principalId'] !== scope.principalId || owner['projectId'] !== scope.projectId) throw new MayuraError('INVALID_INPUT', 'Memory scope is inconsistent.');
  const id = memoryId(item['id']); const version = integer(item['version'], 'Memory version');
  const createdAt = timestamp(item['createdAt']); const updatedAt = timestamp(item['updatedAt']);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new MayuraError('INVALID_INPUT', 'Memory update time precedes creation.');
  if (item['status'] === 'deleted') {
    exactKeys(item, [...identity, 'deletedAt']);
    const deletedAt = timestamp(item['deletedAt']);
    if (deletedAt !== updatedAt || version < 2) throw new MayuraError('INVALID_INPUT', 'Memory tombstone is inconsistent.');
    return { id, version, status: 'deleted', scope: { ...scope }, sensitivity: sensitivity(item['sensitivity']), createdAt, updatedAt, deletedAt };
  }
  if (item['status'] !== 'active') throw new MayuraError('INVALID_INPUT', 'Unknown memory state.');
  exactKeys(item, [...identity, 'category', 'content', 'contentSha256', 'metadata', 'provenance', 'validity']);
  const record = activeRecord(item, scope, version, createdAt, updatedAt);
  if (item['contentSha256'] !== record.contentSha256) throw new MayuraError('INVALID_INPUT', 'Memory content integrity check failed.');
  return record;
}

/** Plain immutable JSON snapshots keep caller mutations away from canonical records. */
export function immutable<T>(value: T): T { return freezeJson(jsonValue(value, { maxBytes: MAX_AGGREGATE_BYTES, maxNodes: 100_000 })) as unknown as T; }
