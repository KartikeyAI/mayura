// Copied into the immutable capsule root; owner tooling only, never a published package entry point.
import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {qualifyPineconeStarter} from './scripts/pinecone-live-check.mjs';
import {regionalRunner,verifyFreeAllowance,compareRegional} from './regional-controls.mjs';
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const baseline=await read('baseline.json');const corpus=await read('corpus.json');const manifest=await read('manifest.json');
for(const [path,hash] of Object.entries(manifest.runtimeHashes))
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),hash,'RUNTIME_DRIFT');
assert.deepEqual(manifest.runtimeHashes,baseline.execution.runtimeHashes);
assert.equal(process.version,baseline.runtime.node);assert.equal(corpus.manifest.sha256,baseline.qualification.corpus.sha256);
assert.equal(createHash('sha256').update(JSON.stringify(corpus.chunks)).digest('hex'),corpus.manifest.sha256);
const runner=await read('/out/runner.json');regionalRunner(runner.region);
const allowance=verifyFreeAllowance(await read('/out/allowance.json'));
if(process.argv.includes('--verify-only')){console.log('Exact runtime, corpus, region and free allowance verified.');}
else{
  assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1','RERUN_REQUIRES_NEW_ALLOWANCE');
  const controller=new AbortController();const cancel=()=>controller.abort();process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
  const persist=async report=>{
    const result={...report,sourceHashes:baseline.sourceHashes,runtime:{node:process.version,platform:process.platform,arch:process.arch,kernel:os.release()},
      execution:{runtimeHashes:manifest.runtimeHashes,image:manifest.image,resources:{cpus:1,memoryMiB:1024},runner,allowance,
        isolation:'Fresh GitHub-hosted Virginia VM; one-CPU/1-GiB container. No exclusive physical-host claim.'}};
    await writeFile('/out/pinecone-regional.json.tmp',JSON.stringify(result,null,2)+'\n',{mode:0o600,flush:true});
    await rename('/out/pinecone-regional.json.tmp','/out/pinecone-regional.json');
  };
  try{
    const report=await qualifyPineconeStarter({starterConfirmed:true,maxCostMicros:0,apiKey:process.env.PINECONE_API_KEY,
      profile:'load',loadProfile:baseline.loadProfile,corpus,signal:controller.signal,onReport:persist,
      permissions:{allow:['rag:qualify','rag:qualify:load','rag:transport:pinecone','rag:admin:pinecone']},progress:message=>console.log(message)});
    const result=await read('/out/pinecone-regional.json');
    await writeFile('/out/pinecone-regional-comparison.json',JSON.stringify(compareRegional(baseline,result),null,2)+'\n');
    console.log(`Qualification: ${report.status}; index cleanup: ${report.indexCleanup}.`);process.exitCode=report.status==='passed'?0:1;
  }finally{process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel);}
}
