import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const sources=['scripts/pgvector-production-check.mjs','scripts/live/pgvector-production-checks.mjs',
  'scripts/live/rag-load-checks.mjs','scripts/rag-local-check.mjs',
  'extensions/vector-pgvector/src/index.ts','packages/rag/src/validation.ts'];

/** Refuse source drift before spending runner time; paths come from this allowlist, never from a report. */
export async function verifySources(report) {
  assert.deepEqual(Object.keys(report.sourceHashes).sort(),[...sources].sort(),'Unexpected source manifest');
  for(const path of sources)assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),report.sourceHashes[path],`Source drift: ${path}`);
}

/** Compare identical workloads across hosts. Diagnostics never override the original traffic or recovery gates. */
export function compareProduction(baseline,isolated) {
  for(const key of ['image','profile','resources','postgresSettings','sourceHashes','engine'])
    assert.deepEqual(isolated[key],baseline[key],`Incomparable ${key}`);
  assert.equal(isolated.runtime.node,baseline.runtime.node,'Incomparable Node version');
  assert.deepEqual(isolated.qualification.profile,baseline.qualification.profile,'Incomparable effective workload');
  assert.equal(isolated.qualification.loadWindows.length,2,'Incomplete windows');
  const summarize=report=>report.qualification.loadWindows.map(window=>({
    index:window.index,offered:window.offeredQueries,completed:window.completedQueries,
    late:window.late,skipped:window.skipped,errors:window.errors,p95Ms:window.p95Ms,
    requestsPerSecond:window.requestsPerSecond,recallAt10:window.recallAt10,
    diagnostics:window.diagnostics
  }));
  for(const window of isolated.qualification.loadWindows)assert.ok(window.diagnostics?.schedulerLag&&window.diagnostics?.eventLoop,'Missing scheduler diagnostics');
  const profile=isolated.profile;
  const trafficPassed=isolated.qualification.loadWindows.every(window=>window.errors===0&&window.recallAt10===1
    &&window.skipped+window.late<=window.offeredQueries*.01&&window.completedQueries>=window.offeredQueries*.99
    &&window.requestsPerSecond>=profile.qps*.99&&window.p95Ms<=profile.maxP95Ms);
  const qualified=isolated.status==='passed'&&isolated.qualification.status==='passed'&&isolated.containerCleanup==='passed'
    &&isolated.qualification.cleanup==='passed'&&isolated.qualification.checks.every(check=>check.status==='passed');
  if(qualified)assert.ok(trafficPassed,'Passing report contradicts traffic gates');
  return {format:1,kind:'pgvector-production-host-comparison',sameWorkload:true,sameQualificationSources:true,
    isolatedQualified:qualified,trafficPassed,ragStatus:'experimental',hostedQualified:false,
    baseline:{runtime:baseline.runtime,status:baseline.status,windows:summarize(baseline)},
    isolated:{runtime:isolated.runtime,status:isolated.status,windows:summarize(isolated),recovery:isolated.qualification.recovery,
      cleanup:isolated.qualification.cleanup,containerCleanup:isolated.containerCleanup},
    limitations:['Host and operating system differ; this comparison alone does not isolate the cause of Windows stalls.',
      'A fresh hosted VM is not a guarantee of exclusive physical hardware or a hosted database qualification.']};
}

async function main(args) {
  const read=async path=>JSON.parse(await readFile(path,'utf8'));
  if(args.length===2&&args[0]==='--verify-source'){await verifySources(await read(args[1]));console.log('Qualification sources match the baseline.');return;}
  if(args.length!==3)throw new Error('Usage: compare-pgvector-production baseline.json isolated.json output.json');
  const result=compareProduction(await read(args[0]),await read(args[1]));
  await writeFile(args[2],JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(()=>{console.error('COMPARISON_FAILED_OR_INCOMPLETE_EVIDENCE');process.exitCode=1;});
