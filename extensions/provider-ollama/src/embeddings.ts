import { MayuraError } from 'mayura/core';
import type { RagEmbedder } from 'mayura/rag';
import { cancelled, integer, ragHttp, vector, type RagHttpOptions } from 'mayura/rag/host';
export interface EmbeddingsOptions extends Omit<RagHttpOptions,'endpoint'|'headers'> {
  readonly model:string; readonly dimensions:number; readonly maxBatch:number; readonly costMicros:number;
  readonly endpoint:string; readonly location:"local"|"hosted";
}
/** Explicit native embedding transport. Declared cost is the host's ceiling per bounded request. */
export function ollamaEmbeddings(options:EmbeddingsOptions):RagEmbedder {
  if(typeof options.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.model))throw new MayuraError('INVALID_CONFIG','Embedding model must be explicit and bounded.');
  const dimensions=integer(options.dimensions,1,4096);const maxBatch=integer(options.maxBatch,1,128);const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);
  const endpoint=options.endpoint;const url=new URL(endpoint);if(!['local','hosted'].includes(options.location)||options.location==='local'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new MayuraError('INVALID_CONFIG','Local embedding location requires a loopback endpoint.');
  const request=ragHttp('ollama-embeddings',{...options,endpoint,headers:{}});
  return Object.freeze({id:`ollama.embeddings.${options.model}.${dimensions}`,dimensions,maxBatch,costMicros,location:options.location,
    async embed(texts:readonly string[],signal:AbortSignal) {
      cancelled(signal);if(texts.length<1||texts.length>maxBatch||texts.some(value=>typeof value!=='string'||!value.trim()||value.length>8000))throw new MayuraError('INVALID_INPUT','Embedding batch exceeds its bounds.');
      try { const response=await request('/api/embed',{model:options.model,input:texts,dimensions,truncate:false},signal);const rows=response['embeddings'];if(!Array.isArray(rows)||rows.length!==texts.length)throw new Error();return rows.map(row=>vector(row as number[],dimensions)); }
      catch {throw new MayuraError(signal.aborted?'CANCELLED':'MODEL_FAILED','Embedding operation failed; no automatic retry was performed.');}
    },
  });
}
