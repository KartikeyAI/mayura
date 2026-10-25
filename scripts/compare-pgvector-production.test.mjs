import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {compareProduction,verifySources} from './compare-pgvector-production.mjs';
const baseline=JSON.parse(await readFile(new URL('../compatibility/pgvector-production-qualification.json',import.meta.url),'utf8'));

test('compares failed evidence without promoting RAG or hiding missed traffic',()=>{
  const result=compareProduction(baseline,structuredClone(baseline));
  assert.equal(result.sameWorkload,true);assert.equal(result.isolatedQualified,false);
  assert.equal(result.trafficPassed,false);assert.equal(result.ragStatus,'experimental');assert.equal(result.hostedQualified,false);
  assert.deepEqual(result.baseline.windows,result.isolated.windows);
});
test('refuses changed gates, image, source hashes or incomplete diagnostics',()=>{
  for(const change of [r=>{r.profile.qps=1;},r=>{r.image='different';},r=>{r.sourceHashes={};},
    r=>{r.qualification.loadWindows[0].diagnostics=undefined;}]){
    const other=structuredClone(baseline);change(other);assert.throws(()=>compareProduction(baseline,other));
  }
});
test('never accepts a passing status that contradicts the unchanged traffic gates',()=>{
  const other=structuredClone(baseline);other.status='passed';other.qualification.status='passed';
  other.qualification.checks.forEach(check=>{check.status='passed';});
  assert.throws(()=>compareProduction(baseline,other),/traffic gates/);
});
test('verifies exact source bytes and rejects untrusted source paths',async()=>{
  await verifySources(baseline);
  await assert.rejects(verifySources({...baseline,sourceHashes:{'../outside':'x'}}));
});
