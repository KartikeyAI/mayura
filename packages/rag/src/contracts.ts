import type { Authorizer, Permissions, Scope } from '@mayura/core';
import type { MemoryEmbedder } from '@mayura/memory';

/** Flat, portable equality filters. Reserved framework fields cannot be overridden. */
export type RagMetadata = Readonly<Record<string, string | number | boolean>>;
export type RagSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export interface RagDocument {
  readonly id: string; readonly text: string; readonly reference: string;
  readonly metadata: RagMetadata; readonly sensitivity: RagSensitivity;
}
/** UTF-16 offsets refer to the exact normalized loader output, never to original binary files. */
export interface RagChunk extends RagDocument {
  readonly documentId: string; readonly revision: string; readonly start: number; readonly end: number;
  readonly parent?: { readonly text:string; readonly start:number; readonly end:number };
  /** Generated retrieval context, never a quotation or source instruction. */
  readonly context?: string;
}
export interface RagVector { readonly chunk: RagChunk; readonly values: readonly number[] }
export interface RagHit { readonly chunk: RagChunk; readonly score: number; readonly parent?: { readonly text:string; readonly start:number; readonly end:number } }
export interface RagQuery {
  readonly scope: Scope; readonly space: string; readonly vector: readonly number[];
  readonly limit: number; readonly filter: RagMetadata; readonly signal: AbortSignal;
}
/** Trusted infrastructure boundary. Applications expose it through createRetriever, never directly to a browser. */
export interface VectorStore {
  readonly id: string; readonly dimensions: number; readonly location: 'local' | 'hosted';
  /** Maximum charge for one bounded query/write/delete operation. */
  readonly costMicros: number;
  upsert(scope: Scope, space: string, entries: readonly RagVector[], signal: AbortSignal): Promise<void>;
  query(input: RagQuery): Promise<readonly RagHit[]>;
  delete(scope: Scope, space: string, ids: readonly string[], signal: AbortSignal): Promise<void>;
  lexical?(input: Omit<RagQuery, 'vector'> & { readonly text: string }): Promise<readonly RagHit[]>;
}
export interface RagRevision {
  readonly revision: string; readonly space: string; readonly chunkIds: readonly string[];
  readonly contentHash: string; readonly deleted: boolean;
}
/** Compare-and-set publication fences concurrent ingestion and deletion. */
export interface RagCatalog {
  read(scope: Scope, documentId: string, signal: AbortSignal): Promise<RagRevision | undefined>;
  publish(scope: Scope, documentId: string, expectedRevision: string | null, next: RagRevision, signal: AbortSignal): Promise<void>;
}
/** Host-specified maximum charge for one bounded embedding request, not a provider price estimate. */
export interface RagEmbedder extends MemoryEmbedder { readonly costMicros: number }
export interface RagReranker {
  readonly id: string; readonly location: 'local' | 'hosted'; readonly costMicros: number;
  rank(query: string, documents: readonly string[], signal: AbortSignal): Promise<readonly { readonly index: number; readonly score: number }[]>;
}
/** One bounded model operation. Host owns model permissions/pricing and any prompt or output guard. */
export interface RagQueryTransform {
  readonly id: string; readonly costMicros: number;
  readonly mode: 'rewrite' | 'multi-query' | 'hyde';
  transform(query: string, signal: AbortSignal): Promise<readonly string[]>;
}
export interface RagAccess {
  readonly scope: Scope; readonly permissions: Permissions; readonly authorization?: Authorizer;
  readonly allowedSensitivities: readonly RagSensitivity[];
  /** Explicitly admitted sensitivity profile for all hosted embeddings/rerankers. Defaults to empty. */
  readonly hostedSensitivities?: readonly RagSensitivity[];
}
export interface RetrievalMetrics {
  readonly queries: number; readonly candidates: number; readonly returned: number;
  readonly reservedCostMicros: number; readonly durationMs: number;
}
export interface RetrievalResult { readonly hits: readonly RagHit[]; readonly metrics: RetrievalMetrics }
export interface Retriever {
  readonly scope: Scope; readonly costMicros: number;
  retrieve(query: string, options?: { readonly signal?: AbortSignal }): Promise<RetrievalResult>;
}

export interface RagCitation {
  readonly documentId:string;readonly revision:string;readonly chunkId:string;readonly reference:string;
  readonly start:number;readonly end:number;
}
export interface RagEvidence {readonly text:string;readonly score:number;readonly citation:RagCitation;readonly retrievalContext?:string}
export interface RetrievalToolOutput {readonly evidence:readonly RagEvidence[];readonly metrics:RetrievalMetrics}
