/** Scope-local BM25 statistics for the optional reference lexical scorer. No global corpus statistics. */
export class Bm25Index {
  private readonly documents = new Map<string,{length:number;terms:ReadonlyMap<string,number>}>();
  private readonly postings = new Map<string,Map<string,number>>();
  private length = 0;
  private words(text:string):string[] { return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []; }
  set(id:string,text:string):void {
    this.delete(id);const words=this.words(text);const terms=new Map<string,number>();
    for(const word of words)terms.set(word,(terms.get(word)??0)+1);
    this.documents.set(id,{length:words.length,terms});this.length+=words.length;
    for(const [term,count]of terms){let posting=this.postings.get(term);if(!posting){posting=new Map();this.postings.set(term,posting);}posting.set(id,count);}
  }
  delete(id:string):void {
    const doc=this.documents.get(id);if(!doc)return;this.length-=doc.length;this.documents.delete(id);
    for(const term of doc.terms.keys()){const posting=this.postings.get(term)!;posting.delete(id);if(!posting.size)this.postings.delete(term);}
  }
  scores(text:string):ReadonlyMap<string,number> {
    const scores=new Map<string,number>();const n=this.documents.size;if(!n)return scores;
    const average=this.length/n||1;
    for(const term of [...new Set(this.words(text))].slice(0,64)){
      const posting=this.postings.get(term);if(!posting)continue;
      const idf=Math.log(1+(n-posting.size+.5)/(posting.size+.5));
      for(const [id,tf]of posting){const doc=this.documents.get(id)!;
        const score=idf*tf*2.2/(tf+1.2*(.25+.75*doc.length/average));scores.set(id,(scores.get(id)??0)+score);}
    }return scores;
  }
  /** Choose a real passage using the same partition-local document-frequency statistics. */
  scoreText(query:string,text:string):number {
    const words=this.words(text);const tf=new Map<string,number>();for(const word of words)tf.set(word,(tf.get(word)??0)+1);
    const n=this.documents.size;if(!n)return 0;const average=this.length/n||1;let score=0;
    for(const term of [...new Set(this.words(query))].slice(0,64)){const count=tf.get(term)??0;const df=this.postings.get(term)?.size??0;
      if(count&&df)score+=Math.log(1+(n-df+.5)/(df+.5))*count*2.2/(count+1.2*(.25+.75*words.length/average));}
    return score;
  }
}
