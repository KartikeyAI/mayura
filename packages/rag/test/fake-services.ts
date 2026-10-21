/** Offline service emulators exercise native protocol encoding/decoding; no real service/credential is used. */
export function fakeVectorFetch(vendor:'pinecone'|'qdrant'|'chroma'|'weaviate'):typeof fetch {
  type Row={id:string;vector:number[];metadata:Record<string,unknown>};const rows=new Map<string,Row>();
  return (async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));const body=JSON.parse(String(init?.body??'{}')) as Record<string,any>;const path=url.pathname;
    const reply=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    const rank=(vector:number[],filter:(row:Row)=>boolean,limit:number)=>[...rows.values()].filter(filter).map(row=>({...row,score:row.vector.reduce((sum,value,index)=>sum+value*vector[index]!,0)})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
    if(vendor==='pinecone') {
      if(path.endsWith('/upsert')){for(const row of body['vectors'])rows.set(`${body['namespace']}:${row.id}`,{id:row.id,vector:row.values,metadata:{...row.metadata,ns:body['namespace']}});return reply({});}
      if(path.endsWith('/delete')){for(const id of body['ids'])rows.delete(`${body['namespace']}:${id}`);return reply({});}
      const ranked=rank(body['vector'],row=>row.metadata['ns']===body['namespace']&&Object.entries(body['filter']).every(([key,value])=>row.metadata[key]===(value as any).$eq),body['topK']);return reply({matches:ranked.map(row=>({id:row.id,score:row.score,metadata:row.metadata}))});
    }
    if(vendor==='qdrant') {
      if(init?.method==='PUT'){for(const row of body['points'])rows.set(row.id,{id:row.id,vector:row.vector,metadata:row.payload});return reply({result:{status:'completed'}});}
      if(path.endsWith('/delete')){for(const id of body['points'])rows.delete(id);return reply({result:{status:'completed'}});}
      const ranked=rank(body['query'],row=>body['filter'].must.every((term:any)=>term.match?row.metadata[term.key]===term.match.value:row.metadata[term.key]===term.range.gte),body['limit']);return reply({result:{points:ranked.map(row=>({id:row.id,score:row.score,payload:row.metadata}))}});
    }
    if(vendor==='chroma') {
      if(path.endsWith('/upsert')){body['ids'].forEach((id:string,index:number)=>rows.set(id,{id,vector:body['embeddings'][index],metadata:body['metadatas'][index]}));return reply({});}
      if(path.endsWith('/delete')){for(const id of body['ids'])rows.delete(id);return reply({});}
      const terms=body['where'].$and??[body['where']];const ranked=rank(body['query_embeddings'][0],row=>terms.every((term:any)=>Object.entries(term).every(([key,value])=>row.metadata[key]===(value as any).$eq)),body['n_results']);return reply({ids:[ranked.map(row=>row.id)],metadatas:[ranked.map(row=>row.metadata)],distances:[ranked.map(row=>1-row.score)]});
    }
    if(path.endsWith('/objects')&&init?.method==='POST'){for(const row of body['objects'])rows.set(row.id,{id:row.id,vector:row.vector,metadata:row.properties});return reply(body['objects'].map(()=>({result:{status:'SUCCESS'}})));}
    if(init?.method==='DELETE'){const terms=body['match'].where.operands;for(const [id,row]of rows)if(row.metadata['mayuraNamespace']===terms[0].valueText&&terms[1].operands.some((term:any)=>term.valueText===row.metadata['mayuraId']))rows.delete(id);return reply({results:{failed:0}});}
    const query=body['query'] as string;const collection=/Get\{([A-Za-z0-9_]+)\(/u.exec(query)![1]!;const vector=JSON.parse(/vector:(\[[^\]]+\])/u.exec(query)![1]!);const limit=Number(/limit:(\d+)/u.exec(query)![1]);
    const terms=[...query.matchAll(/path:\["([A-Za-z0-9_]+)"\],operator:Equal,value(?:Text|Number|Boolean):("(?:[^"\\]|\\.)*"|[\d.]+|true|false)/gu)].map(match=>[match[1]!,JSON.parse(match[2]!)] as const);
    const ranked=rank(vector,row=>terms.every(([key,value])=>row.metadata[key]===value),limit);return reply({data:{Get:{[collection]:ranked.map(row=>({...row.metadata,_additional:{id:row.id,distance:1-row.score}}))}}});
  }) as typeof fetch;
}
/** Driver stub executes the bounded table contract, while assertions use the common behavioral suite. */
export function fakeSql(vendor:'pgvector'|'libsql') {
  const rows=new Map<string,{namespace:string;id:string;chunk:string;metadata:Record<string,unknown>;values:number[]}>();
  return async(sql:string,params:readonly(string|number)[],signal:AbortSignal):Promise<Record<string,unknown>[]>=>{
    if(signal.aborted)throw new Error('aborted');if(sql.startsWith('CREATE'))return [];
    if(sql.startsWith('INSERT')){rows.set(`${params[0]}:${params[1]}`,{namespace:String(params[0]),id:String(params[1]),chunk:String(params[2]),metadata:JSON.parse(String(params[3])),values:JSON.parse(String(params[4]))});return [];}
    if(sql.startsWith('DELETE')){for(const id of JSON.parse(String(params[1])))rows.delete(`${params[0]}:${id}`);return [];}
    const vector=JSON.parse(String(params[vendor==='pgvector'?1:0])) as number[];const ns=String(params[vendor==='pgvector'?0:1]);const filter:Record<string,unknown>=vendor==='pgvector'?JSON.parse(String(params[2])):{};
    if(vendor==='libsql')for(let index=2;index<params.length-1;index+=4)filter[String(params[index]).slice(2)]=params[index+3];
    return [...rows.values()].filter(row=>row.namespace===ns&&Object.entries(filter).every(([key,value])=>row.metadata[key]===value)).map(row=>({chunk:row.chunk,score:row.values.reduce((sum,value,index)=>sum+value*vector[index]!,0),id:row.id})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,Number(params.at(-1)));
  };
}
