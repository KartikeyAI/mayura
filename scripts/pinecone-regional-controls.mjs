import assert from 'node:assert/strict';

/** Permit only metadata-confirmed Virginia runners; never infer location from a runner label or IP. */
export function regionalRunner(location) {
  assert.ok(['eastus','eastus2'].includes(location),'RUNNER_NOT_VERIFIED_NEAR_INDEX');
  return {cloud:'Azure',region:location,geography:'Virginia, United States',indexCloud:'AWS',indexRegion:'us-east-1',
    evidence:'Azure IMDS compute/location; cross-cloud proximity, not same-region or private-network equivalence.'};
}

/** Reserve the full byte ceiling plus margin, treating delayed usage as entirely unreflected. */
export function verifyFreeAllowance(value,now=Date.now()) {
  assert.equal(value.plan,'Starter','FREE_PLAN_REQUIRED');
  assert.equal(value.source,'Pinecone console','CONSOLE_EVIDENCE_REQUIRED');
  const age=now-Date.parse(value.observedAt);
  assert.ok(Number.isFinite(age)&&age>=0&&age<=15*60_000,'STALE_ALLOWANCE');
  for(const key of ['limitBytes','usedUpperBoundBytes','pendingUpperBoundBytes'])
    assert.ok(Number.isSafeInteger(value[key])&&value[key]>=0,'INVALID_ALLOWANCE');
  assert.equal(value.limitBytes,1_000_000_000,'UNREVIEWED_FREE_LIMIT');
  const remaining=value.limitBytes-value.usedUpperBoundBytes-value.pendingUpperBoundBytes;
  assert.ok(remaining>=200*1024*1024+10_000_000,'INSUFFICIENT_FREE_EGRESS_RESERVE');
  assert.equal(value.otherUsageReserved,true,'UNRESERVED_CONCURRENT_USAGE');
  return {...value,reservedResponseBytes:200*1024*1024,safetyMarginBytes:10_000_000,conservativeRemainingBytes:remaining};
}

/** A comparison may preserve failed evidence, but cannot accept changed gates or contradict the receipt. */
export function compareRegional(baseline,current) {
  assert.deepEqual(current.loadProfile,baseline.loadProfile,'CHANGED_PROFILE');
  assert.deepEqual(current.sourceHashes,baseline.sourceHashes,'CHANGED_QUALIFICATION_SOURCES');
  assert.equal(current.qualification.corpus.sha256,baseline.qualification.corpus.sha256,'CHANGED_CORPUS');
  assert.equal(current.runtime.node,baseline.runtime.node,'CHANGED_NODE');
  assert.deepEqual(current.execution.runtimeHashes,baseline.execution.runtimeHashes,'CHANGED_RUNTIME_BYTES');
  regionalRunner(current.execution.runner.region);
  const q=current.qualification;const r=q.retrieval;assert.ok(r,'INCOMPLETE_RETRIEVAL');
  const p=current.loadProfile;
  const trafficPassed=r.offeredQueries===600&&r.errors===0&&r.late+r.skipped<=r.offeredQueries*.01
    &&r.completedQueries>=r.offeredQueries*.99&&r.requestsPerSecond>=p.qps*.99&&r.p95Ms<=p.maxP95Ms
    &&r.meanRecallAt10>=p.minMeanRecallAt10&&r.minRecallAt10>=p.minPerQueryRecallAt10;
  const qualified=current.status==='passed'&&q.status==='passed'&&q.cleanup==='passed'&&current.indexCleanup==='passed'
    &&current.otherIndexNamesPreserved===true&&q.checks.every(check=>check.status==='passed');
  if(current.status==='passed')assert.ok(qualified&&trafficPassed,'CONTRADICTORY_PASS');
  return {format:1,kind:'pinecone-regional-latency-comparison',sameProfile:true,sameCorpus:true,sameRuntimeBytes:true,
    runner:current.execution.runner,regionalProfileQualified:qualified&&trafficPassed,ragStatus:'experimental',productionReady:false,
    baseline:{status:baseline.status,retrieval:baseline.qualification.retrieval,queryTimings:baseline.queryTimings},
    regional:{status:current.status,retrieval:r,queryTimings:current.queryTimings,cleanup:q.cleanup,indexCleanup:current.indexCleanup,usage:current.usage},
    limitations:['Cross-cloud Virginia runner; this is not an AWS same-region or private-network test.',
      'A single profile result cannot isolate provider-only latency, qualify semantic retrieval or make RAG production-ready.']};
}
