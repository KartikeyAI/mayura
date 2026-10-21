import { MayuraError } from 'mayura/core';
import type { RagEmbedder } from 'mayura/rag';
import { cancelled, integer, ragHttp, vector, type RagHttpOptions } from 'mayura/rag/host';
export interface EmbeddingsOptions extends Omit<RagHttpOptions,'endpoint'|'headers'> {
  readonly model:string; readonly dimensions:number; readonly maxBatch:number; readonly costMicros:number;
  readonly apiKey:string; readonly resource:string;
}
/** Explicit native embedding transport. Declared cost is the host's ceiling per bounded request. */
export function azureEmbeddings(options:EmbeddingsOptions):RagEmbedder {
  if(typeof options.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.model))throw new MayuraError('INVALID_CONFIG','Embedding model must be explicit and bounded.');
  const dimensions=integer(options.dimensions,1,4096);const maxBatch=integer(options.maxBatch,1,128);const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);
  if(typeof options.apiKey!=='string'||!options.apiKey.trim()||/[\r\n]/u.test(options.apiKey))throw new MayuraError('INVALID_CONFIG','Embedding credentials required.');
  if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u.test(options.resource))throw new MayuraError('INVALID_CONFIG','Invalid Azure resource.');
  const endpoint=`https://${options.resource}.openai.azure.com/openai/v1`;
  const request=ragHttp('azure-embeddings',{...options,endpoint,headers:{'api-key':options.apiKey}});
  return Object.freeze({id:`azure.embeddings.${options.model}.${dimensions}`,dimensions,maxBatch,costMicros,location:'hosted' as const,
    async embed(texts:readonly string[],signal:AbortSignal) {
      cancelled(signal);if(texts.length<1||texts.length>maxBatch||texts.some(value=>typeof value!=='string'||!value.trim()||value.length>8000))throw new MayuraError('INVALID_INPUT','Embedding batch exceeds its bounds.');
      try { const response=await request('/embeddings',{model:options.model,input:texts,encoding_format:'float',dimensions},signal);const rows=response['data'];if(!Array.isArray(rows)||rows.length!==texts.length)throw new Error();const output:(readonly number[])[]=[];for(const raw of rows){const row=raw as {index:number;embedding:number[]};const index=integer(row.index,0,texts.length-1);if(output[index])throw new Error();output[index]=vector(row.embedding,dimensions);}return output; }
      catch {throw new MayuraError(signal.aborted?'CANCELLED':'MODEL_FAILED','Embedding operation failed; no automatic retry was performed.');}
    },
  });
}
