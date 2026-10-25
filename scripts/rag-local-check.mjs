// Owner-invoked qualification against real, isolated local engines. No cloud credentials are read.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyRagAdapters } from './live/rag-checks.mjs';
import { qualifyRagLoad } from './live/rag-load-checks.mjs';

const execute = promisify(execFile);
const images = Object.freeze({
  pgvector: { image:'pgvector/pgvector@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21', port:5432 },
  libsql: { image:'ghcr.io/tursodatabase/libsql-server@sha256:f8ca0134cdded747793888e48591aece07647d9d598d3ac229aabfa93159ca88', port:8080 },
  qdrant: { image:'qdrant/qdrant@sha256:0fb8897412abc81d1c0430a899b9a81eb8328aa634e7242d1bc804c1fe8fe863', port:6333 },
  chroma: { image:'chromadb/chroma@sha256:f9cef32d15ba51e15a7d288d0e0086607921c8761ed6717d722e2c055e04798b', port:8000 },
  weaviate: { image:'cr.weaviate.io/semitechnologies/weaviate@sha256:f2405c4e993a91473700c64904315b0cf2548d11212e273560272316f0d844b1', port:8080 },
});

/** Every cleanup requires both the exact generated name and this invocation's ownership label. */
export function ownsContainer(details, name, owner) {
  return details?.Name === `/${name}` && details?.Config?.Labels?.['io.mayura.rag-qualification'] === owner;
}

/** Keep plan structure/timings, without publishing thousands of vector literals or fixture namespaces. */
export function cleanPlan(value) {
  if(typeof value==='string')return value.replace(/\[(?:[-+\d.eE]+\s*,\s*)+[-+\d.eE]+\]/gu,'[vector omitted]').replace(/[a-f0-9]{64}/gu,'<namespace>');
  if(Array.isArray(value))return value.map(cleanPlan);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,cleanPlan(item)]));
  return value;
}

/** The supported pinned libSQL protocol exposes EXPLAIN QUERY PLAN, but rejects ANALYZE statements. */
export async function collectLibsqlPlan(client, query, signal) {
  signal.throwIfAborted();if(!query?.sql.includes('WHERE namespace=?'))throw new Error('MISSING_SCOPED_QUERY');
  const rows=(await client.execute({sql:`EXPLAIN QUERY PLAN ${query.sql}`,args:query.args})).rows;
  return {sql:query.sql,parameters:'bound; vector and namespace values omitted',
    statistics:'as-provisioned; pinned sqld does not support ANALYZE',
    plan:cleanPlan(rows.map(row=>Object.fromEntries(Object.entries(row))))};
}

async function docker(args, env = process.env) {
  return (await execute('docker',args,{env,timeout:120_000,maxBuffer:4_194_304,windowsHide:true})).stdout.trim();
}
async function request(endpoint, path, method = 'GET', body, signal) {
  const response = await fetch(`${endpoint}${path}`,{method,signal:AbortSignal.any([signal,AbortSignal.timeout(5_000)]),
    ...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
  if(!response.ok)throw new Error('SERVICE_SETUP_FAILED');
  const text=await response.text();return text?(response.headers.get('content-type')?.includes('json')?JSON.parse(text):text):{};
}
async function ready(check, signal) {
  const deadline=Date.now()+60_000;
  while(Date.now()<deadline){
    signal.throwIfAborted();
    try{await check();return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('SERVICE_NOT_READY');
}

/** Provision infrastructure only inside the newly created container; never against an existing account/database. */
async function prepare(service, endpoint, password, signal, dimensions = 3) {
  const permissions={allow:['rag:qualify','rag:admin',`rag:transport:${service}`]};
  const common={dimensions,costMicros:0,permissions,timeoutMs:5_000,maxConcurrent:dimensions===3?1:4,endpoint};
  if(service==='pgvector'){
    const {default:pg}=await import('pg');
    const pool=new pg.Pool({host:'127.0.0.1',port:Number(new URL(endpoint).port),user:'mayura',password,database:'mayura_rag',max:4,connectionTimeoutMillis:2_000,statement_timeout:5_000});
    try{
      await ready(()=>pool.query('SELECT 1'),signal);
      await pool.query('CREATE EXTENSION vector');
      const version=(await pool.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0].extversion;
      const {pgvectorStore}=await import('../extensions/vector-pgvector/dist/index.js');
      let query;
      const adapter=pgvectorStore({...common,location:'local',table:'rag_qualification',execute:async(sql,params,signal)=>{
        if(sql.startsWith('SELECT chunk,'))query={sql,params:[...params]};
        signal.throwIfAborted();return (await pool.query({text:sql,values:[...params],query_timeout:5_000})).rows;
      }});
      await adapter.initialize(signal);
      return {adapter,version,close:()=>pool.end(),explain:async signal=>{
        signal.throwIfAborted();if(!query?.sql.includes('WHERE namespace=$1'))throw new Error();
        await pool.query('ANALYZE rag_qualification');
        const baseline=(await pool.query({text:`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,values:query.params})).rows[0]['QUERY PLAN'];
        return {sql:query.sql,parameters:'bound; vector and namespace values omitted',statistics:'ANALYZE before EXPLAIN',plan:cleanPlan(baseline)};
      }};
    }catch(error){await pool.end();throw error;}
  }
  if(service==='libsql'){
    const require=createRequire(new URL('../extensions/storage-libsql/package.json',import.meta.url));
    const {createClient}=await import(pathToFileURL(require.resolve('@libsql/client')).href);
    const client=createClient({url:endpoint});
    try{
      await ready(()=>client.execute('SELECT 1'),signal);
      const version=(await client.execute('SELECT sqlite_version() AS version')).rows[0].version;
      const {libsqlVectorStore}=await import('../extensions/vector-libsql/dist/index.js');
      let query;
      const adapter=libsqlVectorStore({...common,location:'local',table:'rag_qualification',execute:async(sql,args,signal)=>{
        if(sql.startsWith('SELECT chunk,'))query={sql,args:[...args]};
        signal.throwIfAborted();return (await client.execute({sql,args:[...args]})).rows;
      }});
      await adapter.initialize(signal);
      return {adapter,version,close:()=>client.close(),explain:async signal=>{
        // The pinned sqld parser rejects ANALYZE; inspect the native as-provisioned plan without changing it.
        return collectLibsqlPlan(client,query,signal);
      }};
    }catch(error){client.close();throw error;}
  }
  if(service==='qdrant'){
    await ready(()=>request(endpoint,'/readyz','GET',undefined,signal),signal);
    const info=await request(endpoint,'/','GET',undefined,signal);
    await request(endpoint,'/collections/rag_qualification','PUT',{vectors:{size:dimensions,distance:'Cosine'}},signal);
    const {qdrantVectorStore}=await import('../extensions/vector-qdrant/dist/index.js');
    return {adapter:qdrantVectorStore({...common,collection:'rag_qualification'}),version:info.version};
  }
  if(service==='chroma'){
    await ready(()=>request(endpoint,'/api/v2/heartbeat','GET',undefined,signal),signal);
    const version=await request(endpoint,'/api/v2/version','GET',undefined,signal);
    const collection=await request(endpoint,'/api/v2/tenants/default_tenant/databases/default_database/collections','POST',
      {name:'rag_qualification',metadata:{'hnsw:space':'cosine'},get_or_create:false},signal);
    const {chromaVectorStore}=await import('../extensions/vector-chroma/dist/index.js');
    return {adapter:chromaVectorStore({...common,tenant:'default_tenant',database:'default_database',collection:collection.id}),version};
  }
  await ready(()=>request(endpoint,'/v1/.well-known/ready','GET',undefined,signal),signal);
  const info=await request(endpoint,'/v1/meta','GET',undefined,signal);
  await request(endpoint,'/v1/schema','POST',{class:'RagQualification',vectorizer:'none',vectorIndexConfig:{distance:'cosine'},
    properties:[{name:'mayuraNamespace',dataType:['text'],tokenization:'field'},
      {name:'mayuraId',dataType:['text'],tokenization:'field'},
      {name:'mayuraChunk',dataType:['text'],indexFilterable:false,indexSearchable:false},
      {name:'topic',dataType:['text'],tokenization:'field'},{name:'published',dataType:['boolean']}]},signal);
  const {weaviateVectorStore}=await import('../extensions/vector-weaviate/dist/index.js');
  return {adapter:weaviateVectorStore({...common,collection:'RagQualification'}),version:info.version};
}

export async function main(args) {
  if(args.length===1&&args[0]==='--help'){
    console.log('Usage: pnpm rag:local-check --service all|pgvector|libsql|qdrant|chroma|weaviate [--load] [--out <report.json>]');return 0;
  }
  let selected;let output;let load=false;
  for(let index=0;index<args.length;index++){
    if(args[index]==='--service'&&!selected&&args[index+1]&&!args[index+1].startsWith('--'))selected=args[++index];
    else if(args[index]==='--out'&&!output&&args[index+1]&&!args[index+1].startsWith('--'))output=args[++index];
    else if(args[index]==='--load'&&!load)load=true;
    else{console.error('INVALID_ARGUMENTS');return 2;}
  }
  if(selected!=='all'&&!Object.hasOwn(images,selected??'')){console.error('EXPLICIT_SERVICE_REQUIRED');return 2;}
  const services=selected==='all'?Object.keys(images):[selected];
  const profiles=services.flatMap(service=>(load?[768,1536]:[3]).map(dimensions=>({service,dimensions})));
  const owner=randomUUID();const controller=new AbortController();const cancel=()=>controller.abort();
  process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  const report={format:1,kind:load?'rag-local-load-qualification':'rag-local-service-qualification',runtime:{node:process.version,platform:process.platform,arch:process.arch},startedAt:new Date().toISOString(),services:[],status:'failed'};
  try{
    report.sourceHashes=Object.fromEntries(await Promise.all(['scripts/rag-local-check.mjs','scripts/live/rag-checks.mjs','scripts/live/rag-load-checks.mjs','packages/rag/src/http.ts','packages/rag/src/validation.ts',...services.map(name=>`extensions/vector-${name}/src/index.ts`)].map(async path=>[path,createHash('sha256').update(await readFile(new URL(`../${path}`,import.meta.url))).digest('hex')])));
    for(const {service,dimensions} of profiles){
      if(controller.signal.aborted)break;
      console.log(`Qualifying ${service} at ${dimensions} dimensions against a fresh local container.`);
      const spec=images[service];const name=`mayura-rag-${service}-${dimensions}-${owner}`;
      const item={service,dimensions,image:spec.image,status:'failed',containerCleanup:'not-created',phase:'image'};report.services.push(item);
      let host;let attempted=false;
      try{
        const image=JSON.parse(await docker(['image','inspect',spec.image]));
        item.imageId=image[0].Id;item.repoDigests=image[0].RepoDigests;
        const password=randomBytes(24).toString('hex');
        const env={...process.env,POSTGRES_PASSWORD:password};
        const options=service==='pgvector'?['--env','POSTGRES_PASSWORD','--env','POSTGRES_USER=mayura','--env','POSTGRES_DB=mayura_rag']:
          service==='weaviate'?['--env','AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true','--env','DEFAULT_VECTORIZER_MODULE=none','--env','CLUSTER_HOSTNAME=qualification','--env','DISABLE_TELEMETRY=true','--env','GOMEMLIMIT=512MiB']:
          service==='qdrant'?['--env','QDRANT__TELEMETRY_DISABLED=true']:
          service==='chroma'?['--env','ANONYMIZED_TELEMETRY=false']:[];
        item.phase='container';
        attempted=true;
        await docker(['run','--detach','--name',name,'--label',`io.mayura.rag-qualification=${owner}`,
          '--cpus','1','--memory','768m','--publish',`127.0.0.1::${spec.port}`,...options,spec.image],env);
        const details=JSON.parse(await docker(['inspect',name]))[0];
        if(!ownsContainer(details,name,owner))throw new Error();
        const port=details.NetworkSettings.Ports[`${spec.port}/tcp`]?.[0];
        if(port?.HostIp!=='127.0.0.1')throw new Error();
        const endpoint=`http://127.0.0.1:${port.HostPort}`;
        item.phase='provision';
        host=await prepare(service,endpoint,password,controller.signal,dimensions);item.serviceVersion=host.version;
        item.phase='qualification';
        item.qualification=load?await qualifyRagLoad({adapter:host.adapter,permissions:{allow:['rag:qualify:load']},maxCostMicros:0,maxOperations:1000,
          exact:service==='pgvector'||service==='libsql',explain:host.explain,signal:controller.signal}):await qualifyRagAdapters({mode:'live',permissions:{allow:['rag:qualify']},
          profiles:[{id:`local-${service}`,kind:'vector',adapter:host.adapter}],maxOperations:100,maxCostMicros:0,
          maxReadAttempts:5,visibilityDelayMs:250,maxDurationMs:60_000,cleanupTimeoutMs:10_000,signal:controller.signal});
        item.status=item.qualification.status;
        if(item.status==='passed')delete item.phase;
      }catch{item.status='failed';item.code='SETUP_OR_QUALIFICATION_FAILED';}
      finally{
        try{await host?.close?.();}catch{item.status='failed';item.code='HOST_CLEANUP_FAILED';}
        // Even a failed docker-run response can have created the container; inspect the exact generated name.
        try{
          const details=JSON.parse(await docker(['inspect',name]))[0];
          if(!ownsContainer(details,name,owner))throw new Error();
          await docker(['rm','--force','--volumes',name]);item.containerCleanup='passed';
        }catch{if(attempted){item.containerCleanup='unconfirmed';item.status='failed';}}
      }
      console.log(`${service}: ${item.status}; container cleanup: ${item.containerCleanup}.`);
    }
    report.status=controller.signal.aborted?'cancelled':report.services.length===profiles.length&&report.services.every(item=>item.status==='passed'&&item.containerCleanup==='passed')?'passed':'failed';
  }catch{report.status='failed';}
  finally{
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
    report.completedAt=new Date().toISOString();
    const path=resolve(output??`.artifacts/rag-local-qualification-${owner}.json`);
    await mkdir(dirname(path),{recursive:true});await writeFile(path,`${JSON.stringify(report,null,2)}\n`,{mode:0o600});
    console.log(`Report: ${path}`);
  }
  return report.status==='passed'?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main(process.argv.slice(2));
