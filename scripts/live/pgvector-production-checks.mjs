import { randomUUID } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { vectorFixture, exactNeighbors, summarizeLatency } from './rag-load-checks.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const integer=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail('INVALID_CONFIG');return value;};
const delay=(ms,signal)=>new Promise((resolve,reject)=>{
  const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();};
  const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(Object.assign(new Error('CANCELLED'),{code:'CANCELLED'}));};
  const timer=setTimeout(finish,Math.max(0,ms));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});

/** Validate the complete local resource envelope before constructing adapters or starting Docker. */
export function productionProfile(input={}) {
  const records=integer(input.records??10_000,64,50_000);
  const dimensions=integer(input.dimensions??1536,2,4096);
  if(records*dimensions*4>400_000_000)fail('PROFILE_MEMORY_LIMIT');
  const durationMs=integer(input.durationMs??300_000,100,3_600_000);
  const qps=integer(input.qps??10,1,100);
  const concurrency=integer(input.concurrency??4,1,16);
  const maxQueued=integer(input.maxQueued??32,0,1024);
  const maxOperations=integer(input.maxOperations??10_000,1,500_000);
  const decoys=Math.max(16,Math.ceil(records/4));
  // Includes rounded-up slots in both windows, verification, inventory, plans and independent cleanup.
  const requiredOperations=Math.ceil(records/32)+3*Math.ceil(decoys/32)+Math.ceil(records/128)+3*Math.ceil(decoys/128)
    +Math.ceil(durationMs*qps/1000)+128;
  if(requiredOperations>maxOperations)fail('OPERATION_LIMIT');
  return Object.freeze({records,dimensions,durationMs,qps,concurrency,maxQueued,maxOperations,decoys,requiredOperations,
    maxP95Ms:integer(input.maxP95Ms??1000,1,30_000),maxRecoveryMs:integer(input.maxRecoveryMs??30_000,1,120_000)});
}

/**
 * Local production-readiness profile, not hosted qualification. Two sustained healthy-load windows bracket
 * a graceful restart; a crash with an uncommitted write follows. No writes or failed queries are replayed.
 * Host recovery must act only on its own disposable engine. No raw service errors enter evidence.
 */
export async function qualifyPgvectorProduction(options) {
  if(!['rag:qualify:production','rag:qualify:recovery'].every(grant=>options?.permissions?.allow?.includes(grant)))fail('PERMISSION_DENIED');
  const profile=productionProfile(options.profile);
  const {adapter,host}=options;
  if(adapter.location!=='local'||adapter.costMicros!==0||adapter.dimensions!==profile.dimensions||options.maxCostMicros!==0)fail('LOCAL_FREE_PROFILE_REQUIRED');
  for(const name of ['inventory','recover','explain'])if(typeof host?.[name]!=='function')fail('INVALID_CONFIG');
  const controller=new AbortController();const relay=()=>controller.abort();
  options.signal?.addEventListener('abort',relay,{once:true});if(options.signal?.aborted)relay();
  const timer=setTimeout(relay,profile.durationMs+360_000);
  const report={format:1,kind:'pgvector-production-qualification',scope:'local Docker; synthetic corpus',profile,
    status:'failed',checks:[],loadWindows:[],recovery:[],cleanup:'not-started',ragStatus:'experimental',hostedQualified:false};
  let operations=0;let uncertainWrite=false;const touched=[];
  const call=async(body,signal=controller.signal)=>{
    if(signal.aborted)fail('CANCELLED');if(++operations>profile.maxOperations)fail('OPERATION_LIMIT');
    let abort;
    try{return await Promise.race([Promise.resolve().then(()=>body(signal)),new Promise((_,reject)=>{
      abort=()=>reject(Object.assign(new Error('CANCELLED'),{code:'CANCELLED'}));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    })]);}finally{if(abort)signal.removeEventListener('abort',abort);}
  };
  const check=async(name,body)=>{
    options.progress?.(name);
    try{const details=await body();report.checks.push({name,status:'passed',...details});}
    catch(error){report.checks.push({name,status:'failed',code:['CANCELLED','CONTRACT_FAILED','LOAD_SLO_FAILED','RECOVERY_FAILED','OPERATION_LIMIT'].includes(error.code)?error.code:'ADAPTER_FAILED'});throw error;}
  };
  const nonce=`ragprod-${randomUUID()}`;const scope={principalId:`${nonce}-owner`,projectId:nonce};
  const partitions=[{scope,space:`${nonce}-main`,count:profile.records},
    {scope:{...scope,principalId:`${nonce}-other`},space:`${nonce}-main`,count:profile.decoys},
    {scope:{...scope,projectId:`${nonce}-other`},space:`${nonce}-main`,count:profile.decoys},
    {scope,space:`${nonce}-other`,count:profile.decoys}];
  const key=index=>`chunk${String(index).padStart(6,'0')}`;
  const text='Public synthetic production qualification data. '.repeat(48);
  const entry=(index,partition)=>({chunk:{id:key(index),documentId:`doc${index}`,revision:'c'.repeat(64),text,
    reference:`https://example.invalid/${nonce}/${partition}/${index}`,metadata:{topic:`t${Math.floor(index/32)%8}`,published:index%3!==0},sensitivity:'public',start:0,end:text.length},
    values:vectorFixture(profile.dimensions,index)});
  const primary=Array.from({length:profile.records},(_,index)=>entry(index,0));
  const queries=Array.from({length:24},(_,index)=>{
    const vector=vectorFixture(profile.dimensions,index*17+7,true);
    const filter=index%3===0?{}:index%3===1?{topic:`t${index%8}`}:{topic:`t${index%8}`,published:true};
    const expected=exactNeighbors(primary,vector,filter,10);
    return {vector,filter,expected,scores:new Map(expected.map(hit=>[hit.id,hit.score]))};
  });
  const read=(query,signal=controller.signal,partition=partitions[0])=>call(signal=>adapter.query({scope:partition.scope,space:partition.space,
    vector:Array.from(query.vector),filter:query.filter,limit:10,signal}),signal);
  const verify=(rows,query)=>{
    if(!Array.isArray(rows)||rows.length!==query.expected.length)fail('CONTRACT_FAILED');
    const ids=new Set();
    for(const hit of rows){
      const row=primary[Number(hit.chunk?.id?.slice(5))];
      if(!row||ids.has(hit.chunk.id)||!isDeepStrictEqual(row.chunk,hit.chunk)||!Number.isFinite(hit.score))fail('CONTRACT_FAILED');
      if(!Object.entries(query.filter).every(([key,value])=>row.chunk.metadata[key]===value))fail('CONTRACT_FAILED');
      // Reuse the independently computed oracle; never rescan vectors on the traffic scheduler's event loop.
      const expectedScore=query.scores.get(hit.chunk.id);
      if(expectedScore===undefined||Math.abs(hit.score-expectedScore)>0.0001)fail('CONTRACT_FAILED');ids.add(hit.chunk.id);
    }
    if(query.expected.some(hit=>!ids.has(hit.id)))fail('CONTRACT_FAILED');
    for(let index=1;index<rows.length;index++)if(rows[index].score>rows[index-1].score+0.000001)fail('CONTRACT_FAILED');
  };
  const validateQueries=async()=>{for(const query of queries)verify(await read(query),query);};
  const load=async(durationMs,index)=>{
    const interval=1000/profile.qps;const slots=Math.ceil(durationMs/interval);const started=performance.now();
    const active=new Set();const pending=[];const samples=[];const queueWaits=[];const windows=new Map();
    const schedulerLag=[];const adapterLatency=[];const verificationLatency=[];
    const eventLoop=monitorEventLoopDelay({resolution:10});eventLoop.enable();
    const utilization=performance.eventLoopUtilization();const cpu=process.cpuUsage();
    let skipped=0;let errors=0;let late=0;let maximumQueued=0;
    const pump=()=>{
      while(active.size<profile.concurrency&&pending.length){
        const job=pending.shift();const query=queries[job.slot%queries.length];
        const wait=performance.now()-job.arrival;queueWaits.push(wait);
        const work=(async()=>{
          try{
            const requestStart=performance.now();const rows=await read(query);const received=performance.now();
            adapterLatency.push(received-requestStart);const ms=received-job.arrival;
            verify(rows,query);verificationLatency.push(performance.now()-received);samples.push(ms);job.group.latencies.push(ms);
          }
          catch{errors++;job.group.errors++;}
        })();active.add(work);void work.finally(()=>{active.delete(work);pump();});
      }
    };
    try{
      for(let slot=0;slot<slots;slot++){
        if(slot&&slot%Math.max(1,profile.qps*30)===0)options.progress?.(`load window ${index}: ${samples.length} completed, ${errors} errors, ${skipped+late} missed`);
        const arrival=started+slot*interval;
        await delay(arrival-performance.now(),controller.signal);
        const drift=performance.now()-arrival;
        schedulerLag.push(Math.max(0,drift));
        if(drift>Math.max(100,interval)){late++;continue;}
        if(active.size>=profile.concurrency&&pending.length>=profile.maxQueued){skipped++;continue;}
        const bucket=Math.floor(slot*interval/30_000);if(!windows.has(bucket))windows.set(bucket,{latencies:[],errors:0});
        pending.push({slot,arrival,group:windows.get(bucket)});pump();maximumQueued=Math.max(maximumQueued,pending.length);
      }
    }finally{
      // Drain accepted reads before recovery or cleanup, including cancellation observers.
      while(active.size||pending.length){pump();await Promise.allSettled([...active]);}
      eventLoop.disable();
    }
    // Include the tail of the requested interval instead of overstating QPS by one slot.
    await delay(started+durationMs-performance.now(),controller.signal);
    const usedCpu=process.cpuUsage(cpu);
    const result={index,requestedDurationMs:durationMs,offeredQueries:slots,completedQueries:samples.length,errors,skipped,late,maximumQueued,
      diagnostics:{schedulerLag:summarizeLatency(schedulerLag,0),adapterLatency:summarizeLatency(adapterLatency,0),
        verificationLatency:summarizeLatency(verificationLatency,0),eventLoop:{p95Ms:eventLoop.percentile(95)/1e6,
          p99Ms:eventLoop.percentile(99)/1e6,maxMs:eventLoop.max/1e6,utilization:performance.eventLoopUtilization(utilization).utilization},
        cpuMs:{user:usedCpu.user/1000,system:usedCpu.system/1000}},
      queueWait:summarizeLatency(queueWaits,0),latencyIncludesQueue:true,
      ...summarizeLatency(samples,performance.now()-started),recallAt10:samples.length?1:null,
      intervals:[...windows].map(([bucket,group])=>({offsetMs:bucket*30_000,errors:group.errors,...summarizeLatency(group.latencies,0)}))};
    report.loadWindows.push(result);
    if(errors||skipped+late>slots*.01||samples.length<slots*.99||result.requestsPerSecond<profile.qps*.99||result.p95Ms>profile.maxP95Ms)fail('LOAD_SLO_FAILED');
  };
  const loadCheck=async(name,duration,index)=>{
    try{await check(name,()=>load(duration,index));}
    catch(error){if(error.code!=='LOAD_SLO_FAILED')throw error;}
  };
  try{
    await check('bounded-corpus-ingestion',async()=>{
      const start=performance.now();
      for(let partition=0;partition<partitions.length;partition++){
        const target=partitions[partition];touched.push(target);
        for(let offset=0;offset<target.count;offset+=32){
          const entries=Array.from({length:Math.min(32,target.count-offset)},(_,i)=>partition===0?primary[offset+i]:entry(offset+i,partition));
          try{await call(signal=>adapter.upsert(target.scope,target.space,entries.map(row=>({...row,values:Array.from(row.values)})),signal));}
          catch(error){uncertainWrite=true;throw error;}
        }
      }
      return {vectors:profile.records+3*profile.decoys,elapsedMs:performance.now()-start};
    });
    let baseline;
    await check('committed-corpus-inventory',async()=>{
      baseline=await call(signal=>host.inventory(signal));
      if(baseline.count!==profile.records+3*profile.decoys||typeof baseline.fingerprint!=='string'||!baseline.fingerprint)fail('CONTRACT_FAILED');
      return {count:baseline.count,bytes:baseline.bytes};
    });
    await check('exact-reference-warmup',validateQueries);
    await loadCheck('sustained-load-before-restart',Math.floor(profile.durationMs/2),1);
    for(const kind of ['graceful','crash-rollback']){
      await check(`${kind}-recovery`,async()=>{
        const start=performance.now();
        const recovery=await call(signal=>host.recover(kind,{scope:{...scope,principalId:`${nonce}-probe`},space:`${nonce}-probe`,
          entry:{...entry(0,4),chunk:{...entry(0,4).chunk,id:'uncommitted-probe'}}},signal));
        const recoveryMs=performance.now()-start;
        report.recovery.push({kind,recoveryMs,...recovery});
        if(recoveryMs>profile.maxRecoveryMs||recovery.replayedWrites!==0||kind==='crash-rollback'&&recovery.uncommittedRows!==0)fail('RECOVERY_FAILED');
        const after=await call(signal=>host.inventory(signal));
        if(after.count!==baseline.count||after.fingerprint!==baseline.fingerprint)fail('RECOVERY_FAILED');
        await validateQueries();return {inventoryPreserved:true,exactQueriesVerified:queries.length};
      });
      if(kind==='graceful')await loadCheck('sustained-load-after-restart',profile.durationMs-Math.floor(profile.durationMs/2),2);
    }
    await check('native-sql-plans',async()=>{
      report.sqlPlans=[];
      for(const query of queries.slice(0,3)){await read(query);report.sqlPlans.push(await call(signal=>host.explain(signal)));}
    });
    report.status=report.checks.every(check=>check.status==='passed')?'passed':'failed';
  }catch{report.status=controller.signal.aborted?'cancelled':'failed';}
  finally{
    const cleanup=new AbortController();const cleanupTimer=setTimeout(()=>cleanup.abort(),30_000);
    try{
      for(const partition of touched){
        for(let offset=0;offset<partition.count;offset+=128)await call(signal=>adapter.delete(partition.scope,partition.space,
          Array.from({length:Math.min(128,partition.count-offset)},(_,i)=>key(offset+i)),signal),cleanup.signal);
      }
      const remaining=await call(signal=>host.inventory(signal),cleanup.signal);
      if(remaining.count!==0)fail('CONTRACT_FAILED');report.cleanup=uncertainWrite?'unconfirmed':'passed';
    }catch{report.cleanup='failed';}
    finally{clearTimeout(cleanupTimer);clearTimeout(timer);options.signal?.removeEventListener('abort',relay);}
    if(report.cleanup!=='passed')report.status='failed';report.operations=operations;
  }
  return report;
}
