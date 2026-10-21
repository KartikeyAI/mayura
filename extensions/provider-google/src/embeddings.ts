import { MayuraError } from 'mayura/core';
import type { RagEmbedder } from 'mayura/rag';
import { cancelled, integer, ragHttp, vector, type RagHttpOptions } from 'mayura/rag/host';
export interface EmbeddingsOptions extends Omit<RagHttpOptions,'endpoint'|'headers'> {
  readonly model:string; readonly dimensions:number; readonly maxBatch:number; readonly costMicros:number;
  readonly apiKey:string;
}
/** Explicit native embedding transport. Declared cost is the host's ceiling per bounded request. */
export function googleEmbeddings(options:EmbeddingsOptions):RagEmbedder {
  if(typeof options.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.model))throw new MayuraError('INVALID_CONFIG','Embedding model must be explicit and bounded.');
  const dimensions=integer(options.dimensions,1,4096);const maxBatch=integer(options.maxBatch,1,128);const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);
  if(typeof options.apiKey!=='string'||!options.apiKey.trim()||/[\r\n]/u.test(options.apiKey))throw new MayuraError('INVALID_CONFIG','Embedding credentials required.');
  const endpoint='https://generativelanguage.googleapis.com/v1beta';
  const request=ragHttp('google-embeddings',{...options,endpoint,headers:{'x-goog-api-key':options.apiKey}});
  return Object.freeze({id:`google.embeddings.${options.model}.${dimensions}`,dimensions,maxBatch,costMicros,location:'hosted' as const,
    async embed(texts:readonly string[],signal:AbortSignal) {
      cancelled(signal);if(texts.length<1||texts.length>maxBatch||texts.some(value=>typeof value!=='string'||!value.trim()||value.length>8000))throw new MayuraError('INVALID_INPUT','Embedding batch exceeds its bounds.');
      try { const response=await request(`/models/${encodeURIComponent(options.model)}:batchEmbedContents`,{requests:texts.map(value=>({model:`models/${options.model}`,content:{parts:[{text:value}]},outputDimensionality:dimensions,taskType:'SEMANTIC_SIMILARITY'}))},signal);const rows=response['embeddings'];if(!Array.isArray(rows)||rows.length!==texts.length)throw new Error();return rows.map(row=>vector((row as {values:number[]}).values,dimensions)); }
      catch {throw new MayuraError(signal.aborted?'CANCELLED':'MODEL_FAILED','Embedding operation failed; no automatic retry was performed.');}
    },
  });
}
