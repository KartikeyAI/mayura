import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

const fail = code => { throw Object.assign(new Error(code),{code}); };
const checked = (value,min,max) => {
  if(!Number.isSafeInteger(value)||value<min||value>max)fail('INVALID_CONFIG');return value;
};
const key = index => `chunk${String(index).padStart(6,'0')}`;
const matches = (metadata,filter) => Object.entries(filter).every(([key,value])=>metadata[key]===value);

/** Stable clustered vectors: reproducible synthetic geometry, not an embedding-model quality benchmark. */
export function vectorFixture(dimensions, index, query = false) {
  let state=((index%32)+1)*2654435761>>>0;
  const next=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296-0.5;};
  const values=Float32Array.from({length:dimensions},()=>next());
  state=(index+1+(query?104729:0))*2246822519>>>0;
  let norm=0;
  for(let position=0;position<dimensions;position++){values[position]+=next()*0.35;norm+=values[position]**2;}
  norm=Math.sqrt(norm);
  for(let position=0;position<dimensions;position++)values[position]/=norm;
  return values;
}
export function summarizeLatency(values, elapsedMs) {
  const sorted=[...values].sort((a,b)=>a-b);
  const percentile=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??0;
  return {count:values.length,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),
    ...(elapsedMs>0?{elapsedMs,requestsPerSecond:values.length*1000/elapsedMs}:{})};
}
/** Exact cosine oracle computes all eligible records, before selecting top-k. */
export function exactNeighbors(records,vector,filter,limit) {
  return records.filter(row=>matches(row.chunk.metadata,filter)).map(row=>{
    let score=0;let norm=0;let qnorm=0;
    for(let index=0;index<vector.length;index++){score+=row.values[index]*vector[index];norm+=row.values[index]**2;qnorm+=vector[index]**2;}
    return {id:row.chunk.id,score:score/Math.sqrt(norm*qnorm)};
  }).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
}

/**
 * Bounded local-only load qualification. The owner must provide a fresh, disposable engine.
 * Admission funds ingestion, visibility reads, measured queries, plans and cleanup before I/O.
 * Writes are attempted once; cleanup has an independent deadline and cannot turn uncertainty into success.
 */
export async function qualifyRagLoad(options) {
  if(!options?.permissions?.allow?.includes('rag:qualify:load'))fail('PERMISSION_DENIED');
  const adapter=options.adapter;
  const dimensions=checked(adapter?.dimensions,2,4096);
  if(adapter.costMicros!==0||options.maxCostMicros!==0)fail('LOCAL_FREE_PROFILE_REQUIRED');
  const count=checked(options.records??4096,64,8192);
  const decoys=checked(options.decoysPerPartition??512,16,2048);
  const concurrency=checked(options.concurrency??4,1,8);
  const queryCount=checked(options.queries??48,6,128);
  const batchSize=32;const attempts=10;
  const maxOperations=checked(options.maxOperations,1,10_000);
  const requiredOperations=Math.ceil(count/batchSize)+3*Math.ceil(decoys/batchSize)+4*attempts
    +queryCount+6+6+Math.ceil(count/128)+3*Math.ceil(decoys/128)+4*attempts;
  if(maxOperations<requiredOperations)fail('OPERATION_LIMIT');
  const minimumRecall=options.exact?1:options.minimumRecall??0.95;
  if(typeof minimumRecall!=='number'||minimumRecall<0.5||minimumRecall>1)fail('INVALID_CONFIG');
  const minimumPerQueryRecall=options.exact?1:options.minimumPerQueryRecall??0.8;
  if(typeof minimumPerQueryRecall!=='number'||minimumPerQueryRecall<0.5||minimumPerQueryRecall>minimumRecall)fail('INVALID_CONFIG');
  const duration=checked(options.maxDurationMs??240_000,1,300_000);
  const controller=new AbortController();const relay=()=>controller.abort();
  options.signal?.addEventListener('abort',relay,{once:true});if(options.signal?.aborted)relay();
  const timer=setTimeout(relay,duration);
  let operations=0;let uncertainWrite=false;
  const report={format:1,kind:'rag-local-load',dimensions,records:count,decoysPerPartition:decoys,totalVectors:count+3*decoys,
    vectorDistribution:'32 seeded clusters with bounded noise',concurrency,queryCount,batchSize,requiredMeanRecallAt10:minimumRecall,requiredMinRecallAt10:minimumPerQueryRecall,
    status:'failed',checks:[],cleanup:'not-started',requiredOperations};
  const invoke=async(body,signal=controller.signal)=>{
    if(signal.aborted)fail('CANCELLED');if(++operations>maxOperations)fail('OPERATION_LIMIT');
    // Race observers against cancellation even if a driver ignores its signal.
    let abort;
    try{return await Promise.race([Promise.resolve().then(()=>body(signal)),new Promise((_,reject)=>{
      abort=()=>reject(Object.assign(new Error('CANCELLED'),{code:'CANCELLED'}));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    })]);}finally{if(abort)signal.removeEventListener('abort',abort);}
  };
  const nonce=`ragload-${randomUUID()}`;
  const scope={principalId:`${nonce}-owner`,projectId:nonce};
  const partitions=[{scope,space:`${nonce}-main`,count},
    {scope:{...scope,principalId:`${nonce}-other`},space:`${nonce}-main`,count:decoys},
    {scope:{...scope,projectId:`${nonce}-project`},space:`${nonce}-main`,count:decoys},
    {scope,space:`${nonce}-other`,count:decoys}];
  const text='Synthetic public retrieval fixture. '.repeat(16);
  const entry=(index,partition)=>({chunk:{id:key(index),documentId:`doc${index}`,revision:'b'.repeat(64),text,
    reference:`https://example.invalid/${nonce}/${partition}/${index}`,metadata:{topic:`t${Math.floor(index/32)%8}`,published:index%3!==0},sensitivity:'public',start:0,end:text.length},
    values:vectorFixture(dimensions,index)});
  const primary=Array.from({length:count},(_,index)=>entry(index,0));
  const touched=[];
  const read=(partition,vector,filter={},limit=10,signal=controller.signal)=>invoke(signal=>adapter.query({...partition,vector:Array.from(vector),filter,limit,signal}),signal);
  const check=async(name,body)=>{try{const details=await body();report.checks.push({name,status:'passed',...details});}catch(error){
    report.checks.push({name,status:'failed',code:['CONTRACT_FAILED','RECALL_FAILED','CANCELLED','VISIBILITY_TIMEOUT','OPERATION_LIMIT'].includes(error.code)?error.code:'ADAPTER_FAILED'});throw error;
  }};
  const queries=Array.from({length:queryCount},(_,index)=>{
    const filter=index%3===0?{}:index%3===1?{topic:`t${index%8}`}:{topic:`t${index%8}`,published:true};
    const vector=vectorFixture(dimensions,index*17+7,true);
    return {vector,filter,expected:exactNeighbors(primary,vector,filter,10)};
  });
  const quality=(rows,query)=>{
    const ids=new Set();
    if(!Array.isArray(rows)||rows.length!==query.expected.length)fail('CONTRACT_FAILED');
    for(const hit of rows){
      const record=primary[Number(hit.chunk?.id?.slice(5))];
      if(!record||record.chunk.id!==hit.chunk.id||ids.has(hit.chunk.id)||!Number.isFinite(hit.score)
        ||!isDeepStrictEqual(record.chunk,hit.chunk)||!matches(hit.chunk.metadata,query.filter))fail('CONTRACT_FAILED');
      const exact=exactNeighbors([record],query.vector,{},1)[0].score;
      if(Math.abs(hit.score-exact)>0.0001)fail('CONTRACT_FAILED');ids.add(hit.chunk.id);
    }
    for(let index=1;index<rows.length;index++)if(rows[index].score>rows[index-1].score+0.000001)fail('CONTRACT_FAILED');
    return query.expected.length?query.expected.filter(hit=>ids.has(hit.id)).length/query.expected.length:1;
  };
  try{
    await check('bounded-ingestion',async()=>{
      const started=performance.now();
      for(let partition=0;partition<partitions.length;partition++){
        const target=partitions[partition];touched.push(target);
        for(let offset=0;offset<target.count;offset+=batchSize){
          const entries=Array.from({length:Math.min(batchSize,target.count-offset)},(_,index)=>partition===0?primary[offset+index]:entry(offset+index,partition));
          try{await invoke(signal=>adapter.upsert(target.scope,target.space,entries.map(row=>({...row,values:Array.from(row.values)})),signal));}
          catch(error){uncertainWrite=true;throw error;}
        }
      }
      const elapsedMs=performance.now()-started;
      return {elapsedMs,vectorsPerSecond:report.totalVectors*1000/elapsedMs};
    });
    await check('bounded-visibility-and-scope',async()=>{
      for(let partition=0;partition<partitions.length;partition++){
        const target=partitions[partition];const last=entry(target.count-1,partition);let visible=false;
        for(let attempt=0;attempt<attempts;attempt++){
          const rows=await read(target,last.values,{},1);
          if(rows.length===1&&rows[0].chunk.id===last.chunk.id&&isDeepStrictEqual(rows[0].chunk,last.chunk)){visible=true;break;}
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        if(!visible)fail('VISIBILITY_TIMEOUT');
      }
    });
    await check('warmup',async()=>{for(const query of queries.slice(0,6))quality(await read(partitions[0],query.vector,query.filter),query);});
    const measured=[];
    await check('concurrent-filtered-retrieval',async()=>{
      const started=performance.now();let next=0;
      const workers=await Promise.allSettled(Array.from({length:concurrency},async()=>{
        while(next<queries.length){const index=next++;const query=queries[index];const start=performance.now();
          const rows=await read(partitions[0],query.vector,query.filter);
          measured[index]={latencyMs:performance.now()-start,recall:quality(rows,query),filter:index%3===0?'unfiltered':index%3===1?'topic':'topic-and-boolean'};
        }
      }));
      const failed=workers.find(worker=>worker.status==='rejected');if(failed)throw failed.reason;
      const minimum=Math.min(...measured.map(row=>row.recall));const mean=measured.reduce((sum,row)=>sum+row.recall,0)/measured.length;
      report.retrieval={...summarizeLatency(measured.map(row=>row.latencyMs),performance.now()-started),meanRecallAt10:mean,minRecallAt10:minimum,
        filters:Object.fromEntries(['unfiltered','topic','topic-and-boolean'].map(filter=>{const rows=measured.filter(row=>row.filter===filter);return [filter,{...summarizeLatency(rows.map(row=>row.latencyMs),0),meanRecallAt10:rows.reduce((sum,row)=>sum+row.recall,0)/rows.length}];}))};
      if(!Number.isFinite(minimum)||!Number.isFinite(mean)||mean<minimumRecall||minimum<minimumPerQueryRecall)fail('RECALL_FAILED');
    });
    if(options.explain)await check('sql-query-plans',async()=>{
      report.sqlPlans=[];
      for(const [name,partition,query] of [['primary-unfiltered',partitions[0],queries[0]],['primary-filtered',partitions[0],queries[2]],['selective-namespace',partitions[1],queries[1]]]){
        await read(partition,query.vector,query.filter);
        const plan=await invoke(signal=>options.explain(signal));
        report.sqlPlans.push({name,...plan});
      }
    });
    report.status='passed';
  }catch{report.status=controller.signal.aborted?'cancelled':'failed';}
  finally{
    const cleanup=new AbortController();const cleanupTimer=setTimeout(()=>cleanup.abort(),30_000);
    try{
      for(const partition of touched){
        for(let offset=0;offset<partition.count;offset+=128)await invoke(signal=>adapter.delete(partition.scope,partition.space,
          Array.from({length:Math.min(128,partition.count-offset)},(_,index)=>key(index+offset)),signal),cleanup.signal);
        let empty=false;
        for(let attempt=0;attempt<attempts;attempt++){
          if((await read(partition,primary[0].values,{},1,cleanup.signal)).length===0){empty=true;break;}
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        if(!empty)fail('VISIBILITY_TIMEOUT');
      }
      report.cleanup=uncertainWrite?'unconfirmed':'passed';
    }catch{report.cleanup='failed';}
    finally{clearTimeout(cleanupTimer);clearTimeout(timer);options.signal?.removeEventListener('abort',relay);}
    if(report.cleanup!=='passed')report.status='failed';report.operations=operations;
  }
  return report;
}
