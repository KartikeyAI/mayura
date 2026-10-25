import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {regionalRunner,verifyFreeAllowance,compareRegional} from './pinecone-regional-controls.mjs';

test('only verified nearby runner regions may spend hosted allowance',()=>{
  for(const region of ['eastus','eastus2'])assert.equal(regionalRunner(region).geography,'Virginia, United States');
  for(const region of ['centralus','unknown','us-east-1',undefined])assert.throws(()=>regionalRunner(region));
});
test('free allowance reserves delayed usage and a full bounded run, and expires',()=>{
  const now=Date.now();const v={plan:'Starter',source:'Pinecone console',observedAt:new Date(now).toISOString(),
    limitBytes:1_000_000_000,usedUpperBoundBytes:460_000_000,pendingUpperBoundBytes:170_000_000,otherUsageReserved:true};
  assert.equal(verifyFreeAllowance(v,now).conservativeRemainingBytes,370_000_000);
  for(const change of [{pendingUpperBoundBytes:340_000_000},{plan:'Standard'},{otherUsageReserved:false},
    {observedAt:new Date(now-900001).toISOString()},{observedAt:new Date(now+1).toISOString()},
    {usedUpperBoundBytes:-1},{limitBytes:2_000_000_000}])assert.throws(()=>verifyFreeAllowance({...v,...change},now));
});
test('comparison keeps failed latency failed and refuses workload, runtime or corpus drift',async()=>{
  const baseline=JSON.parse(await readFile('compatibility/pinecone-load-latency-investigation.json','utf8'));
  const current=structuredClone(baseline);current.execution.runner=regionalRunner('eastus2');
  const result=compareRegional(baseline,current);assert.equal(result.regionalProfileQualified,false);assert.equal(result.productionReady,false);
  for(const edit of [v=>v.loadProfile.maxP95Ms++,v=>v.qualification.corpus.sha256='different',
    v=>v.execution.runtimeHashes={},v=>v.sourceHashes={},v=>v.status='passed',v=>v.execution.runner.region='westus']){
    const bad=structuredClone(current);edit(bad);assert.throws(()=>compareRegional(baseline,bad));
  }
});
