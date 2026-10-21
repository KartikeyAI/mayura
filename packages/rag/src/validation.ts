import { freezeJson, jsonValue, MayuraError, type Schema, type Scope } from '@mayura/core';
import type { RagAccess, RagChunk, RagDocument, RagMetadata, RagRevision, RagSensitivity } from './contracts.js';
export function fail(message = 'RAG input is invalid.'): never { throw new MayuraError('INVALID_INPUT', message); }
export function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(); return value;
}
export function text(value: unknown, max = 16_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(); return value;
}
export function id(value: unknown): string { const s = text(value, 128); if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(s)) fail(); return s; }
export function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(); return value; }
export function snapshot<T>(value: T): T { return freezeJson(jsonValue(value, { maxBytes: 4_194_304, maxNodes: 300_000 })) as unknown as T; }
export function scope(value: Scope): Scope { return snapshot({ principalId: id(value.principalId), projectId: id(value.projectId) }); }
export function sameScope(a: Scope, b: Scope): boolean { return a.principalId === b.principalId && a.projectId === b.projectId; }
export function scopeKey(value: Scope, space: string): string { return JSON.stringify([scope(value).projectId, value.principalId, id(space)]); }
export function metadata(value: RagMetadata): RagMetadata {
  const checked = jsonValue(value, { maxBytes: 4096, maxNodes: 128 });
  if (!checked || typeof checked !== 'object' || Array.isArray(checked) || Object.keys(checked).length > 32) fail();
  for (const [key, entry] of Object.entries(checked)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key) || key.startsWith('mayura') || !['string','number','boolean'].includes(typeof entry) || typeof entry === 'string' && entry.length > 512) fail();
  }
  return snapshot(checked) as RagMetadata;
}
export function sensitivity(value: RagSensitivity): RagSensitivity { if (!['public','internal','confidential','restricted'].includes(value)) fail(); return value; }
export function document(value: RagDocument): RagDocument {
  return snapshot({ id: id(value.id), text: text(value.text, 32_000), reference: text(value.reference, 2048), metadata: metadata(value.metadata), sensitivity: sensitivity(value.sensitivity) });
}
export function chunk(value: RagChunk): RagChunk {
  const doc = document(value); const start = integer(value.start, 0, 32_000); const end = integer(value.end, start + 1, 32_000);
  if (end - start !== doc.text.length) fail();
  let parent: RagChunk['parent'];
  if (value.parent !== undefined) {
    const item=value.parent; const body=text(item.text,8000); integer(item.start,0,start);integer(item.end,end,32_000);
    if(item.end-item.start!==body.length || body.slice(start-item.start,end-item.start)!==doc.text) fail();
    parent={text:body,start:item.start,end:item.end};
  }
  return snapshot({ ...doc, documentId: id(value.documentId), revision: hash(value.revision), start, end,...(parent?{parent}:{}),...(value.context===undefined?{}:{context:text(value.context,1000)}) });
}
export function revision(value: RagRevision): RagRevision {
  if (!Array.isArray(value.chunkIds) || value.chunkIds.length > 128 || new Set(value.chunkIds).size !== value.chunkIds.length || typeof value.deleted !== 'boolean') fail();
  return snapshot({ revision: hash(value.revision), space: id(value.space), contentHash: hash(value.contentHash), chunkIds: value.chunkIds.map(id), deleted: value.deleted });
}
export function vector(value: readonly number[], dimensions: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(v => typeof v !== 'number' || !Number.isFinite(v)) || !value.some(v => v !== 0)) fail('RAG vectors must be finite, nonzero and match the configured dimensions.');
  const norm = Math.hypot(...value); if (!Number.isFinite(norm)) fail(); return Object.freeze(value.map(v => v / norm));
}
export function matches(value: RagMetadata, filter: RagMetadata): boolean { return Object.entries(filter).every(([key, expected]) => Object.hasOwn(value, key) && value[key] === expected); }
export function cancelled(signal: AbortSignal): void { if (signal.aborted) throw new MayuraError('CANCELLED', 'RAG operation cancelled.'); }
export function access(options: RagAccess) {
  const identity = scope(options.scope); const grants = new Set(options.permissions.allow.map(id));
  const profile = [...options.allowedSensitivities].map(sensitivity); const hosted = [...options.hostedSensitivities ?? []].map(sensitivity);
  return Object.freeze({ scope: identity, profile, hosted,
    require(grant: string) { if (!grants.has(grant)) throw new MayuraError('PERMISSION_DENIED', 'RAG permission is required.'); },
    async authorize(action: string, resourceId: string, signal: AbortSignal) {
      cancelled(signal); await options.authorization?.require(identity, action, { kind: 'rag_document', id: resourceId, scope: identity }, { signal }); cancelled(signal);
    },
  });
}
/** Standard Schema implementation used at durable JSON boundaries; no validator dependency. */
export function schema<T>(parse: (value: unknown) => T): Schema<T> {
  return { '~standard': { version: 1, vendor: 'mayura.rag', validate(value) { try { return { value: parse(value) }; } catch { return { issues: [{ message: 'Invalid RAG data.' }] }; } } } };
}
