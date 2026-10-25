import assert from 'node:assert/strict';
import test from 'node:test';
import {inMemoryVectorStore} from '../packages/rag/dist/index.js';
import {productionProfile,qualifyPgvectorProduction} from './live/pgvector-production-checks.mjs';
import {parseProductionArgs,main} from './pgvector-production-check.mjs';

const fixture=()=>{
  const base=inMemoryVectorStore({dimensions:12,maxVectors:1000});const indexed=new Set();let corrupted=false;
  const key=(scope,space,id)=>JSON.stringify([scope,space,id]);
  const adapter={...base,async upsert(scope,space,entries,signal){await base.upsert(scope,space,entries,signal);entries.forEach(row=>indexed.add(key(scope,space,row.chunk.id)));},
    async delete(scope,space,ids,signal){await base.delete(scope,space,ids,signal);ids.forEach(id=>indexed.delete(key(scope,space,id)));}};
  const recoveries=[];
  const host={inventory:async()=>({count:indexed.size,fingerprint:corrupted?'changed':'stable',bytes:1000}),
    recover:async(kind)=>{recoveries.push(kind);return {replayedWrites:0,...(kind==='crash-rollback'?{uncommittedRows:0}:{})};},
    explain:async()=>({plan:['native fixture']})};
  return {adapter,host,recoveries,corrupt:()=>{corrupted=true;}};
};
const options=(f=fixture(),extra={})=>({adapter:f.adapter,host:f.host,maxCostMicros:0,permissions:{allow:['rag:qualify:production','rag:qualify:recovery']},
  // Recovery/control tests avoid imposing real-time throughput gates on shared CI runners.
  profile:{records:64,dimensions:12,durationMs:200,qps:1,concurrency:4,maxOperations:500,maxP95Ms:10000},...extra});

test('local defaults have a bounded corpus, five-minute load and explicit SLOs',()=>{
  const profile=productionProfile();assert.equal(profile.records,10000);assert.equal(profile.dimensions,1536);assert.equal(profile.durationMs,300000);
  assert.equal(profile.qps,10);assert.ok(profile.requiredOperations<profile.maxOperations);
  assert.equal(parseProductionArgs(['--local','--records','25000']).profile.records,25000);
  for(const args of [[],['--local','--seconds'],['--local','--records','0'],['--local','--records','50000','--dimensions','4096'],['--local','--qps','100','--seconds','3600'],['--local','--local']])assert.throws(()=>parseProductionArgs(args));
});

test('completes healthy windows, validates both recoveries, and cleans exact scopes',async()=>{
  const f=fixture();const report=await qualifyPgvectorProduction(options(f));
  assert.equal(report.status,'passed');assert.equal(report.cleanup,'passed');assert.equal(report.loadWindows.length,2);
  assert.deepEqual(f.recoveries,['graceful','crash-rollback']);assert.equal(report.recovery.length,2);assert.equal(report.sqlPlans.length,3);
  assert.equal((await f.host.inventory()).count,0);assert.equal(report.hostedQualified,false);
  for(const window of report.loadWindows){
    assert.equal(window.diagnostics.schedulerLag.count,window.offeredQueries);
    assert.equal(window.diagnostics.adapterLatency.count,window.completedQueries);
    assert.equal(window.diagnostics.verificationLatency.count,window.completedQueries);
    assert.ok(Number.isFinite(window.diagnostics.eventLoop.maxMs));
  }
});

test('cached oracle still rejects incorrect scores and same-scope non-neighbor hits',async()=>{
  for(const mode of ['score','neighbor']){
    const f=fixture();const read=f.adapter.query;let count=0;
    f.adapter.query=async input=>{
      const rows=await read(input);if(++count<=24)return rows;
      if(mode==='score')return rows.map((hit,index)=>index?hit:{...hit,score:hit.score+0.01});
      const all=await read({...input,limit:64,filter:{}});
      const replacement=all.find(hit=>!rows.some(expected=>hit.chunk.id===expected.chunk.id));
      return [replacement,...rows.slice(1)];
    };
    const report=await qualifyPgvectorProduction(options(f));
    assert.equal(report.status,'failed');assert.ok(report.loadWindows[0].errors>0);
    assert.equal(report.cleanup,'passed');
  }
});
test('denied recovery and insufficient operation funding refuse before writes',async()=>{
  const f=fixture();let writes=0;f.adapter.upsert=async()=>{writes++;};
  await assert.rejects(qualifyPgvectorProduction(options(f,{permissions:{allow:['rag:qualify:production']}})),{code:'PERMISSION_DENIED'});
  await assert.rejects(qualifyPgvectorProduction(options(f,{profile:{...options(f).profile,maxOperations:1}})),{code:'OPERATION_LIMIT'});
  assert.equal(writes,0);
});
test('lost committed content or replayed writes cannot pass recovery',async()=>{
  for(const mode of ['lost-data','replay']){
    const f=fixture();f.host.recover=async()=>{if(mode==='lost-data')f.corrupt();return {replayedWrites:mode==='replay'?1:0};};
    const report=await qualifyPgvectorProduction(options(f));assert.equal(report.status,'failed');assert.equal(report.cleanup,'passed');
    assert.ok(report.checks.some(check=>check.code==='RECOVERY_FAILED'));
  }
});
test('a crash that retains uncommitted data fails qualification',async()=>{
  const f=fixture();f.host.recover=async()=>({replayedWrites:0,uncommittedRows:1});
  const report=await qualifyPgvectorProduction(options(f));assert.equal(report.status,'failed');assert.equal(report.cleanup,'passed');
});
test('uncertain ingestion is never retried and never becomes qualified after cleanup',async()=>{
  const f=fixture();const write=f.adapter.upsert;let writes=0;
  f.adapter.upsert=async(...args)=>{writes++;await write(...args);throw new Error('secret-provider-body');};
  const report=await qualifyPgvectorProduction(options(f));assert.equal(writes,1);assert.equal(report.status,'failed');
  assert.equal(report.cleanup,'unconfirmed');assert.ok(!JSON.stringify(report).includes('secret-provider-body'));
});
test('cancellation and cleanup failure prevent passing evidence',async()=>{
  const f=fixture();const control=new AbortController();control.abort();
  const cancelled=await qualifyPgvectorProduction(options(f,{signal:control.signal}));assert.notEqual(cancelled.status,'passed');
  const g=fixture();g.adapter.delete=async()=>{throw new Error('private');};
  const report=await qualifyPgvectorProduction(options(g));assert.equal(report.status,'failed');assert.equal(report.cleanup,'failed');
});
test('CLI refuses absent local opt-in without accessing Docker',async()=>{assert.equal(await main([]),2);});
test('load errors remain failed while independent recovery checks are still collected',async()=>{
  const f=fixture();const read=f.adapter.query;let count=0;
  f.adapter.query=async input=>{if(++count===25)throw new Error('private');return read(input);};
  const report=await qualifyPgvectorProduction(options(f));assert.equal(report.status,'failed');assert.equal(report.cleanup,'passed');
  assert.ok(report.loadWindows[0].errors>0);assert.deepEqual(f.recoveries,['graceful','crash-rollback']);
  assert.ok(report.checks.some(check=>check.code==='LOAD_SLO_FAILED'));
});
test('a slow restart fails its recovery-time gate',async()=>{
  const f=fixture();f.host.recover=async()=>{await new Promise(resolve=>setTimeout(resolve,5));return {replayedWrites:0};};
  const report=await qualifyPgvectorProduction(options(f,{profile:{...options(f).profile,maxRecoveryMs:1}}));
  assert.equal(report.status,'failed');assert.ok(report.checks.some(check=>check.code==='RECOVERY_FAILED'));
});
test('abort-ignoring ingestion is bounded by user cancellation without replay',async()=>{
  const f=fixture();let writes=0;f.adapter.upsert=async()=>{writes++;return new Promise(()=>{});};
  const control=new AbortController();const timer=setTimeout(()=>control.abort(),10);
  try{const report=await qualifyPgvectorProduction(options(f,{signal:control.signal}));assert.equal(writes,1);
    assert.equal(report.status,'failed');assert.equal(report.cleanup,'unconfirmed');
  }finally{clearTimeout(timer);}
});
test('a bounded queue absorbs a short stall and counts queue time in latency',async()=>{
  const f=fixture();const read=f.adapter.query;let reads=0;
  f.adapter.query=async input=>{if(++reads===25)await new Promise(resolve=>setTimeout(resolve,90));return read(input);};
  const report=await qualifyPgvectorProduction(options(f,{profile:{...options(f).profile,durationMs:400,qps:50,concurrency:1,maxQueued:16}}));
  const window=report.loadWindows[0];assert.ok(window.maximumQueued>0);assert.equal(window.skipped,0);
  assert.equal(window.completedQueries,window.offeredQueries);assert.equal(window.latencyIncludesQueue,true);assert.ok(window.queueWait.p95Ms>20);
});
test('queue exhaustion remains a failed traffic gate',async()=>{
  const f=fixture();const read=f.adapter.query;let reads=0;
  f.adapter.query=async input=>{if(++reads>24)await new Promise(resolve=>setTimeout(resolve,80));return read(input);};
  const report=await qualifyPgvectorProduction(options(f,{profile:{...options(f).profile,durationMs:200,qps:100,concurrency:1,maxQueued:1}}));
  assert.equal(report.status,'failed');assert.ok(report.loadWindows[0].skipped>0);assert.equal(report.cleanup,'passed');
});

test('event-loop stalls remain missed arrivals and cannot pass with a fast adapter afterward',async()=>{
  const f=fixture();const read=f.adapter.query;let reads=0;
  f.adapter.query=async input=>{
    if(++reads===25){const until=performance.now()+150;while(performance.now()<until){/* Deliberate scheduler stall. */}}
    return read(input);
  };
  const report=await qualifyPgvectorProduction(options(f,{profile:{...options(f).profile,durationMs:400,qps:100}}));
  assert.equal(report.status,'failed');assert.ok(report.loadWindows[0].late>0);
  assert.ok(report.loadWindows[0].diagnostics.schedulerLag.p99Ms>100);
  assert.equal(report.cleanup,'passed');
});
