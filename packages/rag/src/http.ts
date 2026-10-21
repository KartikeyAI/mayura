import { MayuraError, type Permissions } from '@mayura/core';
import { cancelled, id, integer } from './validation.js';
export interface RagHttpOptions {
  readonly endpoint:string; readonly headers?:Readonly<Record<string,string>>; readonly fetch?:typeof globalThis.fetch;
  readonly permissions:Permissions; readonly timeoutMs:number; readonly maxConcurrent:number;
}
/** Pinned endpoint, bounded response streaming, no redirects/retries, abort-ignoring work retains its slot. */
export function ragHttp(name:string,options:RagHttpOptions) {
  id(name); let base:URL;try{base=new URL(options.endpoint);}catch{throw new MayuraError('INVALID_CONFIG','RAG endpoint is invalid.');}
  if (base.username || base.password || base.search || base.hash || base.protocol!=='https:' && !(base.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) throw new MayuraError('INVALID_CONFIG','RAG transport requires a pinned HTTPS endpoint.');
  let headers:Headers;try{headers=new Headers(options.headers);headers.set('content-type','application/json');}catch{throw new MayuraError('INVALID_CONFIG','RAG transport headers are invalid.');}
  const cap=integer(options.maxConcurrent,1,128); const timeout=integer(options.timeoutMs,1,30_000); const transport=options.fetch ?? globalThis.fetch;
  const admitted=options.permissions.allow.includes(`rag:transport:${name}`); let active=0;
  return async (path:string,body:unknown,signal:AbortSignal,method='POST'):Promise<Record<string,unknown>> => {
    if (!admitted) throw new MayuraError('PERMISSION_DENIED','RAG transport permission required.'); cancelled(signal);
    if (active>=cap) throw new MayuraError('BUDGET_EXCEEDED','RAG transport concurrency limit exceeded.');
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('\\')) throw new MayuraError('INVALID_INPUT','Invalid RAG transport path.');
    const url=new URL(base.href.replace(/\/$/u,'')+path); if (url.origin!==base.origin) throw new MayuraError('INVALID_INPUT','RAG transport origin changed.');
    const serialized=body===undefined ? undefined : JSON.stringify(body); if (serialized && new TextEncoder().encode(serialized).length>4_194_304) throw new MayuraError('INVALID_INPUT','RAG request too large.');
    const control=new AbortController(); const relay=()=>control.abort(); signal.addEventListener('abort',relay,{once:true}); if (signal.aborted) relay();
    const timer=setTimeout(relay,timeout); active++;
    const work=async()=> {
      const response=await transport(url,{method,headers,redirect:'error',signal:control.signal,...(serialized===undefined ? {} : {body:serialized})}); cancelled(control.signal);
      if (!response.ok) { await response.body?.cancel(); throw new MayuraError('MODEL_FAILED','RAG service rejected the operation.'); }
      const reader=response.body?.getReader(); if (!reader) return {};
      let size=0; const parts:Uint8Array[]=[];
      try { for (;;) { const next=await reader.read(); cancelled(control.signal); if (next.done) break; size+=next.value.length; if (size>4_194_304) throw new MayuraError('INVALID_OUTPUT','RAG response too large.'); parts.push(next.value); } }
      finally { await reader.cancel().catch(()=>undefined); reader.releaseLock(); }
      if (!size) return {}; const bytes=new Uint8Array(size); let offset=0; for (const part of parts) {bytes.set(part,offset);offset+=part.length;}
      const result:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); if (Array.isArray(result)) return {results:result}; if (!result || typeof result!=='object') throw new Error(); return result as Record<string,unknown>;
    };
    const pending=work().finally(()=>{active--;clearTimeout(timer);signal.removeEventListener('abort',relay);});
    return await new Promise<Record<string,unknown>>((resolve,reject)=>{
      const abort=()=>reject(new MayuraError('CANCELLED','RAG service operation cancelled or timed out.')); control.signal.addEventListener('abort',abort,{once:true}); if(control.signal.aborted) abort();
      void pending.then(result=>{control.signal.removeEventListener('abort',abort);resolve(result);},()=>{control.signal.removeEventListener('abort',abort);reject(new MayuraError('MODEL_FAILED','RAG service operation failed; reconcile uncertain writes before retrying.'));});
    });
  };
}
