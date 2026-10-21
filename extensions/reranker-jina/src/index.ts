import { MayuraError } from 'mayura/core';
import type { RagReranker } from 'mayura/rag';
import { cancelled, integer, ragHttp, type RagHttpOptions } from 'mayura/rag/host';
export interface RerankerOptions extends Omit<RagHttpOptions,'endpoint'|'headers'> {readonly apiKey:string;readonly model:string;readonly costMicros:number}
/** One bounded ranking request, no SDK retries, only validated original-document indexes are returned. */
export function jinaReranker(options:RerankerOptions):RagReranker {
  if(typeof options.apiKey!=='string'||!options.apiKey.trim()||/[\r\n]/u.test(options.apiKey)||typeof options.model!=='string'||options.model.length>128||!options.model.trim())throw new MayuraError('INVALID_CONFIG','Reranker requires explicit credentials and model.');
  const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);const request=ragHttp('jina',{...options,endpoint:'https://api.jina.ai/v1',headers:{authorization:`Bearer ${options.apiKey}`}});
  return Object.freeze({id:'jina',location:'hosted',costMicros,
    async rank(query:string,documents:readonly string[],signal:AbortSignal) {
      cancelled(signal);if(!query.trim()||query.length>2000||documents.length<1||documents.length>100||documents.some(value=>typeof value!=='string'||value.length>8000))throw new MayuraError('INVALID_INPUT','Reranker input exceeds its bounds.');
      const response=await request('/rerank',{model:options.model,query,documents,top_n:documents.length,return_documents:false},signal);
      const rows=response['results'];if(!Array.isArray(rows)||rows.length>documents.length)throw new MayuraError('INVALID_OUTPUT','Invalid reranker results.');
      const seen=new Set<number>();return rows.map(raw=>{const row=raw as {index:number;relevance_score:number};const index=integer(row.index,0,documents.length-1);if(seen.has(index)||!Number.isFinite(row.relevance_score))throw new MayuraError('INVALID_OUTPUT','Invalid reranker index or score.');seen.add(index);return {index,score:row.relevance_score};});
    },
  });
}
