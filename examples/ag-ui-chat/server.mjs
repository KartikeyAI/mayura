import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { defineAgent, createAuthorizer, z } from 'mayura';
import { defineTool } from 'mayura/tools';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createAggregateRunRecords, createAggregateFrontendToolStore } from 'mayura/storage';
import { createAgentServer } from 'mayura/server';
import { createAgUiAdapter, createAgUiFrontendTools } from 'mayura/ag-ui';

/** Offline local example. Durable state and interrupt secrets are retained; there are no paid/model API calls. */
export async function startAgUiChat({ port = 0, directory = resolve('.data/ag-ui-chat') } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  directory = resolve(directory); await mkdir(directory,{ recursive:true });
  const secretPath = resolve(directory,'interrupt.key'); let key;
  try { key = await readFile(secretPath); } catch (error) { if (error.code !== 'ENOENT') throw error; const seed = randomBytes(32); try { await writeFile(secretPath,seed,{ flag:'wx',mode:0o600 }); } catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; } key = await readFile(secretPath); }
  if (key.byteLength !== 32) throw new Error('Invalid local interrupt key');
  const base = dirname(fileURLToPath(import.meta.url)); const output = resolve(directory,'web');
  await build({ entryPoints:[resolve(base,'main.js')],bundle:true,platform:'browser',format:'esm',outfile:resolve(output,'main.js') });
  const store = createSqliteStore({ filename:resolve(directory,'chat.sqlite') }); await store.initialize(); await store.threads.initialize();
  const scope = { principalId:'demo-user',projectId:'ag-ui-demo' }; const agentId = 'demo.ag-ui';
  const credential = createHmac('sha256',key).update('mayura.demo.session.v1').digest(); const token = credential.toString('hex'); const expiresAtMs = Date.now()+3600000;
  const authorization = createAuthorizer({ permissions:{ allow:['authz:evaluate'] }, policy:{ version:'demo-v1',authorize(request) {
    const allowed = request.subject.principalId === scope.principalId && request.subject.projectId === scope.projectId
      && request.resource.scope.principalId === scope.principalId && request.resource.scope.projectId === scope.projectId;
    return allowed ? { effect:'allow',reason:'allowed',policyVersion:'demo-v1',ruleId:null } : { effect:'deny',reason:'scope_mismatch',policyVersion:'demo-v1',ruleId:null };
  } } });
  const frontend = createAgUiFrontendTools({ agentId, authorization,permissions:{ allow:['ag-ui:frontend-tools'] },
    store:createAggregateFrontendToolStore(store,{ permissions:{ allow:['frontend-tools:store'] } }),
    nativeRecovery:{ permissions:{ allow:['ag-ui:frontend-recover'] } } });
  const choose = frontend.defineTool({ id:'ui.choose',version:'1',description:'Choose a display theme in this browser.',input:z.object({ theme:z.literal('forest') }),
    output:z.object({ selected:z.literal('forest') }),effects:'none',capabilities:[],costMicros:0,timeoutMs:60000 });
  const save = defineTool({ id:'notes.save',version:'1',description:'Save this note locally after approval.',input:z.object({ text:z.string().max(2000) }),output:z.object({ saved:z.literal(true) }),
    effects:'write',capabilities:[],approval:'required',costMicros:0,execute:async ({ text },context) => {
      const id = `${context.runId}:${context.callId}`; context.signal.throwIfAborted();
      await store.create({ scope:JSON.stringify([scope.principalId,scope.projectId,'notes']),id,idempotencyKey:id,definitionHash:'demo-note-v1',state:{ text },events:[{ type:'note.saved',data:{} }] }); return { saved:true };
    } });
  const generate = async request => {
    request.signal.throwIfAborted(); const results = request.messages.filter(message => message.role === 'tool');
    if (!results.length) return { type:'tool_calls',calls:[{ id:'save',toolId:save.id,input:{ text:request.messages.find(message => message.role === 'user')?.content.message } }],usage:{ costMicros:0 } };
    if (results[0].result?.saved !== true) return { type:'final',output:{ reply:'The note was not saved.' },usage:{ costMicros:0 } };
    if (results.length === 1) return { type:'tool_calls',calls:[{ id:'choose',toolId:choose.id,input:{ theme:'forest' } }],usage:{ costMicros:0 } };
    return { type:'final',output:{ reply:'Your approved note is saved. The browser returned its theme selection.' },usage:{ costMicros:0 } };
  };
  const model = { id:'demo-local',maxCostMicros:0,capabilities:{ tools:true,structuredOutput:true,history:true },generate,
    async *stream(request) { const result = await generate(request); if (result.type === 'final') { const text = JSON.stringify(result.output); for (let index=0;index<text.length;index+=12) yield { type:'output.delta',text:text.slice(index,index+12) }; } yield { type:'response',response:result }; } };
  const agent = defineAgent({ id:agentId,version:'1',instructions:'Save one approved note, select the browser theme, then respond.',model,tools:[save,choose],
    input:z.object({ message:z.string().min(1).max(2000) }),output:z.object({ reply:z.string() }),stream:{ field:['reply'],guards:[] } });
  let server; let adapter; let origin;
  const listener = createServer(async (incoming,outgoing) => {
    const control = new AbortController(); outgoing.once('close',() => control.abort());
    try {
      if (!origin || incoming.headers.host !== new URL(origin).host || !['same-origin','none',undefined].includes(incoming.headers['sec-fetch-site'])) { outgoing.writeHead(403); outgoing.end(); return; }
      const url = new URL(incoming.url || '/',origin);
      if (url.search) { outgoing.writeHead(404); outgoing.end(); return; }
      if (incoming.method === 'GET' && ['/','/main.js','/style.css','/session'].includes(url.pathname)) {
        const content = url.pathname === '/session' ? JSON.stringify({ token,tools:[{ name:choose.id,description:choose.description,parameters:choose.inputJsonSchema }] })
          : await readFile(url.pathname === '/main.js' ? resolve(output,'main.js') : resolve(base,url.pathname === '/' ? 'index.html' : 'style.css'));
        outgoing.writeHead(200,{ 'content-type':url.pathname === '/session' ? 'application/json' : url.pathname === '/main.js' ? 'text/javascript' : url.pathname === '/style.css' ? 'text/css' : 'text/html',
          'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
          'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" }); outgoing.end(content); return;
      }
      if (!adapter || !server) { outgoing.writeHead(503); outgoing.end(); return; }
      const chunks = []; let size=0;
      for await (const chunk of incoming) { size+=chunk.length; if (size>262144) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(chunk); }
      const request = new Request(url,{ method:incoming.method,headers:incoming.headers,signal:control.signal,...(size ? { body:Buffer.concat(chunks),duplex:'half' } : {}) });
      const response = await (url.pathname.startsWith('/ag-ui') ? adapter.fetch(request) : server.fetch(request));
      outgoing.writeHead(response.status,Object.fromEntries(response.headers)); const reader=response.body?.getReader();
      try { if (reader) for (;;) { const next=await reader.read(); if (next.done) break; if (outgoing.destroyed) break; if (!outgoing.write(next.value)) await new Promise(resolve => { outgoing.once('drain',resolve); outgoing.once('close',resolve); }); } }
      finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } } outgoing.end();
    } catch { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); }
  });
  await new Promise((resolve,reject) => { listener.once('error',reject); listener.listen(port,'127.0.0.1',resolve); }); origin=`http://127.0.0.1:${listener.address().port}`;
  server=createAgentServer({ publicOrigin:origin,threads:{ store },runRecords:createAggregateRunRecords(store),runExecution:'request',
    agents:[{ agent,permissions:{ allow:['model:demo-local','tool:notes.save','effect:write','tool:ui.choose','frontend:ui.choose'] },limits:{ maxCostMicros:0,maxSteps:5,maxModelCalls:4,maxToolCalls:2,maxDurationMs:120000 } }],
    authenticate:async ({ token:supplied,signal }) => signal.aborted || expiresAtMs<=Date.now() || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied,'hex'),credential) ? null :
      { scope,agentIds:[agentId],capabilities:['runs:read','runs:submit','runs:approve','runs:resume','runs:cancel','threads:read','threads:write'],expiresAtMs } });
  adapter=createAgUiAdapter({ server,publicOrigin:origin,agentId,interruptKey:key,frontendTools:frontend,streaming:'guarded',
    permissions:{ allow:['ag-ui:serve','ag-ui:state','ag-ui:frontend-tools','ag-ui:stream'] },
    input:message => ({ message:typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }),
    state:{ read:() => ({ revision:1,state:{ mode:'local',budgetMicros:0 } }) } });
  return { origin,async close() { adapter.close(); frontend.close(); authorization.close(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); await server.close(); await store.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo=await startAgUiChat({ port:Number(process.env.MAYURA_AG_UI_PORT || 0) }); console.log(`AG-UI chat: ${demo.origin}`);
  const stop=() => void demo.close().then(() => { process.exitCode=0; }); process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
