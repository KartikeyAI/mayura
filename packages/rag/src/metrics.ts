import { integer } from './validation.js';
/** Offline set-based precision/recall, reciprocal rank and binary nDCG. No model or network judge. */
export function retrievalQuality(retrieved: readonly string[], relevant: readonly string[], k: number) {
  integer(k,1,1000); if (retrieved.length > 10_000 || relevant.length > 10_000) throw new Error('RAG evaluation set is too large.');
  const truth = new Set(relevant); const ranked = [...new Set(retrieved)].slice(0,k); const matched = ranked.filter(id => truth.has(id)).length;
  const first = ranked.findIndex(id => truth.has(id));
  const dcg = ranked.reduce((sum,id,index) => sum + (truth.has(id) ? 1 / Math.log2(index + 2) : 0),0);
  const ideal = Array.from({ length:Math.min(truth.size,k) },(_,index) => 1 / Math.log2(index + 2)).reduce((a,b) => a+b,0);
  return Object.freeze({ precisionAtK:matched/k, recallAtK:truth.size ? matched/truth.size : 0, reciprocalRank:first < 0 ? 0 : 1/(first+1), ndcgAtK:ideal ? dcg/ideal : 0 });
}

/** Citation membership only: semantic entailment requires a separate host-owned evaluation. */
export function citationCoverage(usedChunkIds:readonly string[],citedChunkIds:readonly string[]) {
  if(usedChunkIds.length>1000||citedChunkIds.length>1000)throw new Error('RAG citation set too large.');
  const used=new Set(usedChunkIds);const cited=new Set(citedChunkIds);const supported=[...cited].filter(id=>used.has(id)).length;
  return Object.freeze({coverage:used.size?[...used].filter(id=>cited.has(id)).length/used.size:0,unknownCitations:cited.size-supported,complete:used.size>0&&supported===used.size&&supported===cited.size});
}

/** Macro-average test-set recall and reciprocal rank. Empty test sets are rejected rather than scored as success. */
export function evaluateRetrieval(cases:readonly {readonly retrieved:readonly string[];readonly relevant:readonly string[]}[],k:number) {
  integer(cases.length,1,1000);const results=cases.map(item=>retrievalQuality(item.retrieved,item.relevant,k));
  return Object.freeze({cases:cases.length,recallAtK:results.reduce((sum,item)=>sum+item.recallAtK,0)/cases.length,mrr:results.reduce((sum,item)=>sum+item.reciprocalRank,0)/cases.length,ndcgAtK:results.reduce((sum,item)=>sum+item.ndcgAtK,0)/cases.length});
}
