import { MayuraError } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import type { RagChunk, RagDocument, RagMetadata, RagSensitivity } from './contracts.js';
import { document, fail, integer, snapshot, text } from './validation.js';
export interface LoadDocumentOptions { readonly id: string; readonly reference: string; readonly metadata?: RagMetadata; readonly sensitivity: RagSensitivity }
/** Load already acquired text. No filesystem access, URL fetch or HTML execution is implied. */
export function loadText(content: string, options: LoadDocumentOptions): RagDocument {
  return document({ ...options, metadata: options.metadata ?? {}, text: text(content, 32_000).replace(/\r\n?/gu, '\n').normalize('NFC') });
}
/** Markdown remains source text, including code fences; model consumers must treat all chunks as evidence. */
export function loadMarkdown(content: string, options: LoadDocumentOptions): RagDocument { return loadText(content, options); }
/** Extract bounded JSON Pointer string leaves selected by the host. Does not stringify credentials or arbitrary fields. */
export function loadJson(content: string, pointers: readonly string[], options: LoadDocumentOptions): RagDocument {
  text(content, 128_000); if (!Array.isArray(pointers) || pointers.length < 1 || pointers.length > 64) fail();
  let raw:unknown;try{raw=JSON.parse(content);}catch{fail('JSON document is invalid.');}
  const values = pointers.map(pointer => {
    if (typeof pointer !== 'string' || pointer.length > 512 || !pointer.startsWith('/')) fail();
    let value = raw;
    for (const part of pointer.slice(1).split('/')) {
      if (/~(?![01])/u.test(part)) fail(); const key = part.replace(/~1/gu, '/').replace(/~0/gu, '~');
      if (['__proto__','prototype','constructor'].includes(key) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) fail();
      value = (value as Record<string, unknown>)[key];
    }
    return text(value);
  });
  return loadText(values.join('\n\n'), options);
}
export interface ChunkOptions { readonly maxChars: number; readonly overlapChars: number; readonly maxChunks: number; readonly mode?: 'fixed' | 'recursive' | 'markdown'; readonly parentChars?: number }
/** Deterministic paragraph/heading-aware splitting, bounded overlap and exact source offsets. No token-count claim. */
export function chunkDocument(input: RagDocument, revision: string, options: ChunkOptions): readonly RagChunk[] {
  if(options.mode!==undefined&&!['fixed','recursive','markdown'].includes(options.mode))fail();
  const doc = document(input); const max = integer(options.maxChars, 64, 8000); const overlap = integer(options.overlapChars, 0, max - 1);
  const parentChars=options.parentChars===undefined?undefined:integer(options.parentChars,max,8000);
  const cap = integer(options.maxChunks, 1, 128); const output: RagChunk[] = []; let start = 0;
  while (start < doc.text.length) {
    let end = Math.min(start + max, doc.text.length);
    if (end < doc.text.length && options.mode !== 'fixed') {
      const sample = doc.text.slice(start, end); const heading = options.mode === 'markdown' ? sample.lastIndexOf('\n#') : -1;
      const split = Math.max(heading, sample.lastIndexOf('\n\n'), sample.lastIndexOf('\n'), sample.lastIndexOf(' '));
      if (split > Math.max(overlap, Math.floor(max / 2))) end = start + split + 1;
      // Never split a surrogate pair; offsets remain exact UTF-16 positions.
      if (/[\uD800-\uDBFF]/u.test(doc.text[end - 1]!)) end--;
    }
    if (output.length >= cap) fail('Document exceeds the configured chunk budget.');
    const body = doc.text.slice(start, end);
    if (body.trim()) output.push({ ...doc, id: sha256Hex(JSON.stringify([doc.id, revision, start, end])), documentId: doc.id, revision, text: body, start, end,...(parentChars ? {parent:{text:doc.text.slice(start,Math.min(doc.text.length,start+parentChars)),start,end:Math.min(doc.text.length,start+parentChars)}} : {}) });
    if (end === doc.text.length) break;
    start = Math.max(start + 1, end - overlap);
    if (/[\uDC00-\uDFFF]/u.test(doc.text[start]!)) start++;
  }
  return snapshot(output);
}

export interface HtmlParser {
  /** Host-owned DOM parser; must not fetch subresources or execute scripts. */
  parse(content:string):{querySelectorAll(selector:string):Iterable<{remove():void}>;body:{readonly textContent:string|null}};
}
/** Parse inert HTML with a host-installed parser; remove active/hidden content before extracting source text. */
export function loadHtml(content:string,options:LoadDocumentOptions & {readonly parser:HtmlParser;readonly permissions:{readonly allow:readonly string[]}}):RagDocument {
  if(!options.permissions.allow.includes('rag:load:html'))throw new MayuraError('PERMISSION_DENIED','HTML loader permission required.');text(content,128_000);
  let parsed:ReturnType<HtmlParser['parse']>;try{parsed=options.parser.parse(content);}catch{throw new MayuraError('INVALID_INPUT','HTML parsing failed.');}for(const node of parsed.querySelectorAll('script,style,template,noscript,[hidden],[aria-hidden="true"]'))node.remove();
  return loadText(text(parsed.body.textContent,32_000),options);
}
const pdfActive=new WeakMap<PdfParser,number>();
export interface PdfParser {
  /** Host owns the PDF engine, workers/fonts and sandbox. Only text pages cross this boundary. */
  extract(bytes:Uint8Array,options:{readonly signal:AbortSignal;readonly maxPages:number}):Promise<readonly string[]>;
}
/** Bounded PDF acquisition boundary. No URL fetching, embedded attachment extraction or JavaScript execution. */
export async function loadPdf(bytes:Uint8Array,options:LoadDocumentOptions & {readonly parser:PdfParser;readonly permissions:{readonly allow:readonly string[]};readonly signal:AbortSignal;readonly maxPages:number;readonly timeoutMs?:number;readonly maxConcurrent?:number}):Promise<RagDocument> {
  if(!options.permissions.allow.includes('rag:load:pdf'))throw new MayuraError('PERMISSION_DENIED','PDF loader permission required.');
  if(!(bytes instanceof Uint8Array)||bytes.length<5||bytes.length>16_777_216||new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')fail();integer(options.maxPages,1,128);
  if(options.signal.aborted)throw new MayuraError('CANCELLED','PDF loading cancelled.');
  const timeout=integer(options.timeoutMs??5000,1,30_000);const cap=integer(options.maxConcurrent??1,1,16);const count=pdfActive.get(options.parser)??0;
  if(count>=cap)throw new MayuraError('BUDGET_EXCEEDED','PDF parser concurrency limit exceeded.');
  const control=new AbortController();const abort=()=>control.abort();options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();
  const timer=setTimeout(abort,timeout);pdfActive.set(options.parser,count+1);
  const work=Promise.resolve().then(()=>{if(control.signal.aborted)throw new Error();return options.parser.extract(new Uint8Array(bytes),{signal:control.signal,maxPages:options.maxPages});}).finally(()=>{pdfActive.set(options.parser,(pdfActive.get(options.parser)??1)-1);clearTimeout(timer);options.signal.removeEventListener('abort',abort);});
  const pages=await new Promise<readonly string[]>((resolve,reject)=>{
    const stopped=()=>reject(new MayuraError('CANCELLED','PDF loading cancelled or timed out.'));control.signal.addEventListener('abort',stopped,{once:true});if(control.signal.aborted)stopped();
    void work.then(value=>{control.signal.removeEventListener('abort',stopped);if(!control.signal.aborted)resolve(value);},()=>{control.signal.removeEventListener('abort',stopped);reject(new MayuraError(control.signal.aborted?'CANCELLED':'INVALID_INPUT','PDF parsing failed.'));});
  });
  if(options.signal.aborted)throw new MayuraError('CANCELLED','PDF loading cancelled.');if(!Array.isArray(pages)||pages.length<1||pages.length>options.maxPages)fail();
  return loadText(pages.map(page=>text(page,32_000)).join('\n\n'),options);
}
