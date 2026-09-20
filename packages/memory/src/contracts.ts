import type { JsonObject, Permissions, Scope } from '@mayura/core';
import type { AggregateStore } from '@mayura/storage-contracts';

export type MemorySensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type MemoryCategory = 'fact' | 'preference' | 'decision' | 'procedure' | 'episode';

/** Caller-supplied evidence identity, never a claim that the framework fetched or verified a source. */
export interface MemoryProvenance {
  readonly sourceId: string;
  readonly reference: string;
  readonly revision: string;
  readonly sha256: string;
  readonly author: string;
  readonly observedAt: string;
  readonly origin: 'observed' | 'inferred';
  readonly confidence: number;
}
export interface MemoryValidity { readonly from: string; readonly until: string | null }

export interface MemoryInput {
  readonly id: string;
  readonly content: string;
  readonly provenance: MemoryProvenance;
  readonly category?: MemoryCategory;
  readonly metadata?: JsonObject;
  readonly sensitivity?: MemorySensitivity;
  readonly validity?: MemoryValidity;
}
export interface CorrectMemoryInput extends MemoryInput { readonly expectedVersion: number }
export interface ForgetMemoryInput { readonly id: string; readonly expectedVersion: number }

interface MemoryIdentity {
  readonly id: string;
  readonly version: number;
  readonly scope: Scope;
  readonly sensitivity: MemorySensitivity;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface MemoryRecord extends MemoryIdentity {
  readonly status: 'active';
  readonly category: MemoryCategory;
  readonly content: string;
  readonly contentSha256: string;
  readonly metadata: JsonObject;
  readonly provenance: MemoryProvenance;
  readonly validity: MemoryValidity;
}
/** Minimal permanent deletion marker. It intentionally contains no prior content or provenance. */
export interface MemoryTombstone extends MemoryIdentity { readonly status: 'deleted'; readonly deletedAt: string }
export type MemoryEntry = MemoryRecord | MemoryTombstone;

export interface MemoryStoreOptions {
  readonly store: AggregateStore;
  readonly scope: Scope;
  readonly permissions: Permissions;
  readonly allowedSensitivities?: readonly MemorySensitivity[];
}
export interface MemoryListOptions { readonly limit?: number; readonly cursor?: string; readonly includeDeleted?: boolean }
export interface MemoryPage { readonly records: readonly MemoryEntry[]; readonly revision: number; readonly nextCursor?: string }
export interface MemorySearchHit { readonly record: MemoryRecord; readonly score: number; readonly matchedTerms: readonly string[] }
export interface MemorySearchResult { readonly mode: 'lexical'; readonly revision: number; readonly hits: readonly MemorySearchHit[] }
export interface MemoryExport {
  readonly format: 'mayura.memory.export.v1'; readonly scope: Scope; readonly revision: number;
  readonly exportedAt: string; readonly records: readonly MemoryEntry[];
}

/** Experimental bounded native records. No embedding, semantic-index or provider capability is implied. */
export interface MemoryStore {
  add(input: MemoryInput): Promise<MemoryRecord>;
  correct(input: CorrectMemoryInput): Promise<MemoryRecord>;
  forget(input: ForgetMemoryInput): Promise<MemoryTombstone>;
  get(id: string, options?: { readonly includeDeleted?: boolean }): Promise<MemoryEntry | undefined>;
  list(options?: MemoryListOptions): Promise<MemoryPage>;
  search(query: string, options?: { readonly limit?: number }): Promise<MemorySearchResult>;
  exportSnapshot(): Promise<MemoryExport>;
}
