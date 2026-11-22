import type { RagHit } from './contracts.js';

/**
 * Assemble bounded surrounding context from already authorized, same-revision candidate passages.
 * No source is fetched, no gap is invented, and conflicting overlaps are never combined. The
 * returned contributor IDs must all pass the publication fence before this context is released.
 */
export function surroundingEvidence(anchor: RagHit, candidates: readonly RagHit[]): {
  readonly parent: { readonly text: string; readonly start: number; readonly end: number };
  readonly contributorIds: readonly string[];
} | undefined {
  // Parent expansion remains explicitly selected at ingestion. A plain chunk does not gain context.
  if (!anchor.chunk.parent) return undefined;
  const compatible = [anchor,...candidates].filter(hit => hit.chunk.documentId === anchor.chunk.documentId
    && hit.chunk.revision === anchor.chunk.revision && hit.chunk.sensitivity === anchor.chunk.sensitivity
    && hit.chunk.reference === anchor.chunk.reference);
  const spans = compatible.map(hit => ({ id: hit.chunk.id, ...(hit.chunk.parent ?? { text:hit.chunk.text,start:hit.chunk.start,end:hit.chunk.end }) }))
    .sort((a,b) => a.start-b.start || b.end-a.end || a.id.localeCompare(b.id));
  let start=anchor.chunk.parent.start,end=anchor.chunk.parent.end,body=anchor.chunk.parent.text;
  const contributors=new Set([anchor.chunk.id]);
  // Grow only the connected component containing the anchor. Candidates are bounded by retrieval admission.
  for(let changed=true;changed;){changed=false;
    for(const span of spans){
      if(span.end<start||span.start>end||contributors.has(span.id))continue;
      const left=Math.max(start,span.start),right=Math.min(end,span.end);
      if(body.slice(left-start,right-start)!==span.text.slice(left-span.start,right-span.start))continue;
      if(span.start<start){body=span.text.slice(0,start-span.start)+body;start=span.start;changed=true;}
      if(span.end>end){body+=span.text.slice(end-span.start);end=span.end;changed=true;}
      contributors.add(span.id);
    }
  }
  const maximum=Math.min(8000,Math.max(...compatible.map(h=>h.chunk.parent?.text.length??h.chunk.text.length)));
  const spare=Math.max(0,maximum-(anchor.chunk.end-anchor.chunk.start));
  let windowStart=Math.max(start,Math.min(anchor.chunk.start-Math.floor(spare/2),end-maximum));
  let windowEnd=Math.min(end,windowStart+maximum);
  // Moving inward preserves the hard byte-independent UTF-16 budget without splitting a surrogate pair.
  if(windowStart>start&&/[\uDC00-\uDFFF]/u.test(body[windowStart-start]??''))windowStart++;
  if(windowEnd<end&&/[\uD800-\uDBFF]/u.test(body[windowEnd-start-1]??''))windowEnd--;
  if(windowStart>anchor.chunk.start||windowEnd<anchor.chunk.end)return undefined;
  return{parent:{text:body.slice(windowStart-start,windowEnd-start),start:windowStart,end:windowEnd},contributorIds:[...contributors]};
}
