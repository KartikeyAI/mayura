// Explicit local owner tooling. Hosted credentials and .env files are never read by this command.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productionProfile, qualifyPgvectorProduction } from './live/pgvector-production-checks.mjs';
import { ownsContainer, cleanPlan } from './rag-local-check.mjs';

const image='pgvector/pgvector@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21';
const execute=promisify(execFile);
const docker=async(args,env=process.env)=>(await execute('docker',args,{env,windowsHide:true,timeout:120_000,maxBuffer:4_194_304})).stdout.trim();

export function parseProductionArgs(args) {
  let local=false;let output;const input={};const seen=new Set();
  const numbers={'--records':'records','--dimensions':'dimensions','--seconds':'seconds','--qps':'qps','--concurrency':'concurrency','--max-queued':'maxQueued',
    '--max-operations':'maxOperations','--max-p95-ms':'maxP95Ms','--max-recovery-ms':'maxRecoveryMs'};
  for(let index=0;index<args.length;index++){
    const flag=args[index];if(seen.has(flag))throw new Error('INVALID_ARGUMENTS');seen.add(flag);
    if(flag==='--local')local=true;
    else if(flag==='--out'&&args[index+1]&&!args[index+1].startsWith('--'))output=args[++index];
    else if(Object.hasOwn(numbers,flag)&&/^\d+$/u.test(args[index+1]??''))input[numbers[flag]]=Number(args[++index]);
    else throw new Error('INVALID_ARGUMENTS');
  }
  if(!local)throw new Error('LOCAL_OPT_IN_REQUIRED');
  if(input.seconds!==undefined){input.durationMs=input.seconds*1000;delete input.seconds;}
  return {profile:productionProfile(input),output};
}

export async function main(args) {
  if(args.length===1&&args[0]==='--help'){
    console.log('Usage: pnpm rag:production-check --local [--records 10000] [--dimensions 1536] [--seconds 300] [--qps 10] [--concurrency 4] [--out report.json]');return 0;
  }
  let settings;try{settings=parseProductionArgs(args);}catch{console.error('INVALID_PROFILE_OR_MISSING_LOCAL_OPT_IN');return 2;}
  const owner=randomUUID();const name=`mayura-rag-production-${owner}`;
  const controller=new AbortController();const cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  const report={format:1,kind:'pgvector-production-local-run',startedAt:new Date().toISOString(),runtime:{node:process.version,platform:process.platform,arch:process.arch},
    image,profile:settings.profile,resources:{containerCpus:1,containerMemoryMiB:1024},status:'failed',containerCleanup:'not-created',ragStatus:'experimental',hostedQualified:false};
  report.resourceIdentity={containerName:name,labelKey:'io.mayura.rag-qualification',labelValue:owner};
  report.postgresSettings={shared_buffers:'256MB',effective_cache_size:'512MB',max_parallel_workers_per_gather:'0',max_connections:'32'};
  const output=resolve(settings.output??`.artifacts/pgvector-production-${owner}.json`);
  const persist=async()=>{
    await mkdir(dirname(output),{recursive:true});const pending=`${output}.${owner}.tmp`;
    await writeFile(pending,`${JSON.stringify(report,null,2)}\n`,{mode:0o600,flush:true});await rename(pending,output);
  };
  let pool;let transaction;let attempted=false;
  const password=randomBytes(24).toString('hex');
  const owned=async()=>{const details=JSON.parse(await docker(['inspect',name]))[0];if(!ownsContainer(details,name,owner))throw new Error('WRONG_OWNER');return details;};
  const databaseFailure=(error,phase)=>{
    if(error?.code==='STORAGE_UNAVAILABLE'&&report.databaseFailure?.phase===phase)return;
    const codes=['57014','57P01','57P02','57P03','53300','53200','53100','ECONNRESET','ECONNREFUSED','ETIMEDOUT'];
    report.databaseFailure={phase,code:codes.includes(error?.code)?error.code:error?.message==='Query read timeout'?'DRIVER_DEADLINE':'DATABASE_ERROR'};
  };
  try{
    const paths=['scripts/pgvector-production-check.mjs','scripts/live/pgvector-production-checks.mjs','scripts/live/rag-load-checks.mjs','scripts/rag-local-check.mjs',
      'extensions/vector-pgvector/src/index.ts','packages/rag/src/validation.ts'];
    report.sourceHashes=Object.fromEntries(await Promise.all(paths.map(async path=>[path,createHash('sha256').update(await readFile(new URL(`../${path}`,import.meta.url))).digest('hex')])));
    const info=JSON.parse(await docker(['image','inspect',image]))[0];report.imageId=info.Id;report.repoDigests=info.RepoDigests;
    report.status='running';report.containerCleanup='pending';await persist();
    attempted=true;
    await docker(['run','--detach','--name',name,'--label',`io.mayura.rag-qualification=${owner}`,'--cpus','1','--memory','1g',
      '--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_USER=mayura','--env','POSTGRES_DB=production_rag',image,
      ...Object.entries(report.postgresSettings).flatMap(([key,value])=>['-c',`${key}=${value}`])],{...process.env,POSTGRES_PASSWORD:password});
    const details=await owned();const binding=details.NetworkSettings.Ports['5432/tcp'][0];
    if(binding.HostIp!=='127.0.0.1'||!details.Mounts.some(mount=>mount.Type==='volume'))throw new Error('ISOLATION_FAILED');
    const {default:pg}=await import('pg');
    const config={host:'127.0.0.1',port:Number(binding.HostPort),user:'mayura',password,database:'production_rag',max:settings.profile.concurrency,
      connectionTimeoutMillis:2000,statement_timeout:5000};
    const open=()=>{const next=new pg.Pool(config);next.on('error',()=>{});return next;};pool=open();
    const ready=async(signal=controller.signal)=>{
      const deadline=Date.now()+settings.profile.maxRecoveryMs;
      while(Date.now()<deadline){signal.throwIfAborted();try{await pool.query('SELECT 1');return;}catch{await new Promise(resolve=>setTimeout(resolve,250));}}
      throw new Error('SERVICE_NOT_READY');
    };
    await ready();await pool.query('CREATE EXTENSION vector');
    report.engine=(await pool.query("SELECT current_setting('server_version') AS postgres, extversion AS pgvector FROM pg_extension WHERE extname='vector'")).rows[0];
    const {pgvectorStore}=await import('../extensions/vector-pgvector/dist/index.js');
    const {scopeKey}=await import('../packages/rag/dist/host.js');
    const {sha256Hex}=await import('../packages/core/dist/host.js');
    const permissions={allow:['rag:transport:pgvector','rag:admin']};
    const common={location:'local',table:'production_chunks',dimensions:settings.profile.dimensions,costMicros:0,permissions};
    let query;
    const base=pgvectorStore({...common,execute:async(sql,params,signal)=>{
      signal.throwIfAborted();if(sql.startsWith('SELECT chunk,'))query={sql,params:[...params]};
      try{return (await pool.query({text:sql,values:[...params],query_timeout:5000})).rows;}
      catch(error){databaseFailure(error,'vector-operation');throw error;}
    }});
    // One transaction per bounded adapter upsert: acknowledged batches have one durable COMMIT.
    // This is host driver wiring, not a change to VectorStore's public contract or a write retry.
    const adapter=Object.freeze({...base,upsert:async(scope,space,entries,signal)=>{
      signal.throwIfAborted();const client=await pool.connect();let failed=false;
      try{
        await client.query('BEGIN');await client.query("SET LOCAL statement_timeout = '30s'");
        const batch=pgvectorStore({...common,execute:async(sql,params,signal)=>{
          signal.throwIfAborted();try{return (await client.query({text:sql,values:[...params],query_timeout:30000})).rows;}
          catch(error){databaseFailure(error,'transactional-ingestion');throw error;}
        }});
        await batch.upsert(scope,space,entries,signal);
        await client.query({text:'COMMIT',query_timeout:30000});signal.throwIfAborted();
      }catch(error){failed=true;databaseFailure(error,'transactional-ingestion');await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally{client.release(failed);}
    }});
    await adapter.initialize(controller.signal);
    const host={
      inventory:async signal=>{
        signal.throwIfAborted();
        const client=await pool.connect();
        try{
          await client.query('BEGIN');await client.query("SET LOCAL statement_timeout = '30s'");
          const result=await client.query({text:"SELECT count(*)::integer AS count, md5(string_agg(md5(namespace || id || chunk::text || metadata::text || embedding::text), '' ORDER BY namespace,id)) AS fingerprint, pg_total_relation_size('production_chunks')::float8 AS bytes FROM production_chunks",query_timeout:30_000});
          await client.query('COMMIT');return result.rows[0];
        }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
      },
      explain:async signal=>{
        signal.throwIfAborted();if(!query?.sql.includes('WHERE namespace=$1'))throw new Error('MISSING_SCOPED_QUERY');
        await pool.query('ANALYZE production_chunks');
        return {sql:query.sql,statistics:'ANALYZE before EXPLAIN',plan:cleanPlan((await pool.query({text:`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,values:query.params})).rows[0]['QUERY PLAN'])};
      },
      recover:async(kind,probe,signal)=>{
        await owned();signal.throwIfAborted();
        if(kind==='crash-rollback'){
          transaction=await pool.connect();transaction.on('error',()=>{});await transaction.query('BEGIN');
          const staging=pgvectorStore({...common,execute:async(sql,params,signal)=>{signal.throwIfAborted();return (await transaction.query({text:sql,values:[...params],query_timeout:5000})).rows;}});
          await staging.upsert(probe.scope,probe.space,[{...probe.entry,values:Array.from(probe.entry.values)}],signal);
          // Deliberately crash before COMMIT. This synthetic write is never retried.
          await docker(['kill','--signal','KILL',name]);
          transaction.release(true);transaction=undefined;await pool.end();pool=undefined;
          await owned();await docker(['start',name]);
        }else{
          await pool.end();pool=undefined;await docker(['restart','--time','15',name]);
        }
        const restored=await owned();const port=restored.NetworkSettings.Ports['5432/tcp'][0];
        if(port.HostIp!=='127.0.0.1')throw new Error('ISOLATION_FAILED');
        if(!details.Mounts.filter(mount=>mount.Type==='volume').every(before=>restored.Mounts.some(after=>after.Type==='volume'&&after.Name===before.Name&&after.Destination===before.Destination)))throw new Error('PERSISTENT_VOLUME_CHANGED');
        config.port=Number(port.HostPort);pool=open();await ready(signal);
        const remaining=kind==='crash-rollback'?(await pool.query('SELECT count(*)::integer AS count FROM production_chunks WHERE namespace=$1 AND id=$2',
          [sha256Hex(scopeKey(probe.scope,probe.space)),probe.entry.chunk.id])).rows[0].count:undefined;
        return {replayedWrites:0,...(remaining===undefined?{}:{uncommittedRows:remaining}),persistentVolumePreserved:true};
      },
    };
    report.qualification=await qualifyPgvectorProduction({adapter,host,profile:settings.profile,maxCostMicros:0,signal:controller.signal,
      permissions:{allow:['rag:qualify:production','rag:qualify:recovery']},progress:phase=>console.log(`pgvector production: ${phase}`)});
    report.status=report.qualification.status;
  }catch{report.status=controller.signal.aborted?'cancelled':'failed';report.code='SETUP_OR_QUALIFICATION_FAILED';}
  finally{
    if(attempted){try{const details=await owned();report.containerStateBeforeCleanup={running:details.State.Running,oomKilled:details.State.OOMKilled,exitCode:details.State.ExitCode};}catch{}}
    try{transaction?.release(true);await pool?.end();}catch{report.status='failed';report.code='HOST_CLEANUP_FAILED';}
    if(attempted){try{await owned();await docker(['rm','--force','--volumes',name]);report.containerCleanup='passed';}catch{report.containerCleanup='unconfirmed';report.status='failed';}}
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);report.completedAt=new Date().toISOString();
    await persist();console.log(`Qualification: ${report.status}; report: ${output}`);
  }
  return report.status==='passed'?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main(process.argv.slice(2));
