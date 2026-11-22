import {MayuraError} from '@mayura/core';
import type {RagChunk} from './contracts.js';
export const lexicalDocumentKey=(c:RagChunk):string=>JSON.stringify([c.documentId,c.revision]);
/** Aggregation never mixes revisions, references, sensitivity profiles or source metadata. */
export const sourceGroupIdentity=(c:RagChunk):string=>JSON.stringify([c.documentId,c.revision,c.reference,c.sensitivity,Object.entries(c.metadata).sort(([a],[b])=>a.localeCompare(b))]);
/** Reconstruct only known, mutually consistent intervals; gaps become lexical separators, never evidence. */
export function lexicalDocumentText(rows:ReadonlyMap<string,RagChunk>):string {
  if(rows.size>128)throw new MayuraError('BUDGET_EXCEEDED','Document lexical indexing admits at most 128 chunks per revision.');
  const chunks=[...rows.values()].sort((a,b)=>a.start-b.start||a.end-b.end||a.id.localeCompare(b.id));const first=chunks[0];if(!first)return '';
  const expected=sourceGroupIdentity(first);const segments:{start:number;end:number;text:string}[]=[];
  for(const c of chunks){if(sourceGroupIdentity(c)!==expected)throw new MayuraError('INVALID_INPUT','Document lexical chunks must share source metadata and sensitivity.');
    const last=segments.at(-1);if(!last||c.start>last.end){segments.push({start:c.start,end:c.end,text:c.text});continue;}
    const overlap=Math.min(last.end,c.end)-c.start;
    if(last.text.slice(c.start-last.start,c.start-last.start+overlap)!==c.text.slice(0,overlap))throw new MayuraError('INVALID_INPUT','Document lexical intervals disagree.');
    if(c.end>last.end){last.text+=c.text.slice(overlap);last.end=c.end;}
  }return segments.map(s=>s.text).join('\n');
}
