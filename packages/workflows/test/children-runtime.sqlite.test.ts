import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage';
import { createWorkflowTreeRuntime, defineWorkflowTree } from '../src/children.js';
import { defineWorkflow, digest } from '../src/definition.js';

const scope={principalId:'tree-runtime',projectId:'project'};
const stores:ReturnType<typeof createSqliteStore>[]=[];const runtimes:ReturnType<typeof createWorkflowTreeRuntime>[]=[];
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(runtime=>runtime.close()));await Promise.all(stores.splice(0).map(store=>store.close()));});

function fixture(permissions:readonly string[]=['tool:increment'],approval=false){
  const execute=vi.fn(async(value:number)=>value+1);const tool=defineTool({id:'increment',version:'1',description:'Increment a number.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:2,execute});const leaf=defineWorkflow({id:'leaf',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'work',tool,input:{kind:'input',path:[]},approval}],result:{kind:'step',stepId:'work',path:[]}});const tree=defineWorkflowTree({id:'tree',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'child',id:'child',workflow:leaf,input:{kind:'input',path:[]},policy:{permissions,maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{work:[]}}],result:{kind:'step',stepId:'child',path:[]}});return{execute,tree};
}
function runtime(store:ReturnType<typeof createSqliteStore>,verifyHuman?:(credential:unknown)=>Promise<{id:string;projectId:string;canApprove:boolean}>){const value=createWorkflowTreeRuntime({store,scope,permissions:{allow:['tool:increment']},policyVersion:'1',maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,workerId:'worker',leaseMs:3_000,...(verifyHuman?{verifyHuman}:{})});runtimes.push(value);return value;}

describe('workflow-tree developer runtime',()=>{
  it('resumes a submitted tree in another runtime and completes one required child exactly once',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const source=fixture();const first=runtime(store);const submitted=await first.submit(source.tree,{input:1,idempotencyKey:'root'});expect(submitted.status).toBe('running');await first.close();runtimes.splice(runtimes.indexOf(first),1);const second=runtime(store);const finished=await second.runUntilSettled(source.tree,submitted.id);expect(finished).toMatchObject({status:'succeeded',output:2,budget:{accounts:expect.arrayContaining([expect.objectContaining({id:'root',closed:true,spentMicros:2,calls:1})])}});expect(source.execute).toHaveBeenCalledTimes(1);expect(await second.inspect(submitted.id)).toEqual(finished);
  });

  it('fails closed before dispatch when the narrowed child omits its tool grant',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const source=fixture([]);const selected=runtime(store);const submitted=await selected.submit(source.tree,{input:1,idempotencyKey:'denied'});const finished=await selected.runUntilSettled(source.tree,submitted.id);expect(finished.status).toBe('failed');expect(finished.output).toBeNull();expect(finished.budget.accounts.find(account=>account.id==='root')).toMatchObject({closed:true,spentMicros:0,calls:0});expect(source.execute).not.toHaveBeenCalled();
  });

  it('persists exact human approval before dispatching an approval-enabled child tool',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const source=fixture(undefined,true);const verifyHuman=vi.fn(async(credential:unknown)=>{if(credential!=='trusted')throw new Error('denied');return{id:'reviewer',projectId:'project',canApprove:true};});const selected=runtime(store,verifyHuman);const submitted=await selected.submit(source.tree,{input:1,idempotencyKey:'approved-child'});const waiting=await selected.runUntilSettled(source.tree,submitted.id);expect(waiting.status).toBe('waiting');expect(source.execute).not.toHaveBeenCalled();const link=waiting.steps['child']?.child;if(!link)throw new Error('Expected an admitted child.');const child=await selected.inspectChild(waiting.id,link.runId);const review=child.steps['work']?.approval as {digest?:unknown;humanId?:unknown}|null;if(!review||typeof review.digest!=='string')throw new Error('Expected an exact approval digest.');await expect(selected.approve({id:waiting.id,childId:link.runId,nodeId:'work',digest:review.digest,credential:'denied'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(source.execute).not.toHaveBeenCalled();await selected.approve({id:waiting.id,childId:link.runId,nodeId:'work',digest:review.digest,credential:'trusted'});const finished=await selected.runUntilSettled(source.tree,waiting.id);expect(finished).toMatchObject({status:'succeeded',output:2});expect(source.execute).toHaveBeenCalledTimes(1);expect(verifyHuman).toHaveBeenCalledTimes(2);
  });

  it('persists approval and completes a root-local tool exactly once',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const source=fixture();const rootTool=source.tree.nodes[0]!.kind==='child'?source.tree.nodes[0]!.workflow.nodes[0]:undefined;if(!rootTool||rootTool.kind!=='tool')throw new Error('fixture');const tree=defineWorkflowTree({id:'root-tool',version:'1',input:z.number(),output:z.number(),nodes:[{...rootTool,approval:true}],result:{kind:'step',stepId:'work',path:[]}});const verifyHuman=vi.fn(async()=>({id:'root-reviewer',projectId:'project',canApprove:true}));const selected=runtime(store,verifyHuman);const submitted=await selected.submit(tree,{input:1,idempotencyKey:'root-tool'});const waiting=await selected.runUntilSettled(tree,submitted.id);expect(waiting.status).toBe('waiting');expect(source.execute).not.toHaveBeenCalled();const review=waiting.steps['work']?.approval as {digest?:unknown}|null;if(!review||typeof review.digest!=='string')throw new Error('Expected a root approval digest.');await selected.approve({id:waiting.id,nodeId:'work',digest:review.digest,credential:'trusted'});const finished=await selected.runUntilSettled(tree,waiting.id);expect(finished).toMatchObject({status:'succeeded',output:2,budget:{accounts:expect.arrayContaining([expect.objectContaining({id:'root',closed:true,spentMicros:2,calls:1})])}});expect(source.execute).toHaveBeenCalledTimes(1);expect(verifyHuman).toHaveBeenCalledTimes(1);
  });

  it('persists a tree-wide quiescent pause across runtimes before admitting a child',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const source=fixture();const first=runtime(store);
    const submitted=await first.submit(source.tree,{input:1,idempotencyKey:'paused-root'});
    const paused=await first.pause(submitted.id);expect(paused.status).toBe('paused');expect((await first.pause(submitted.id)).version).toBe(paused.version);
    await first.close();runtimes.splice(runtimes.indexOf(first),1);const second=runtime(store);
    expect(await second.runUntilSettled(source.tree,submitted.id)).toMatchObject({status:'paused',steps:{child:{status:'pending',child:null}}});expect(source.execute).not.toHaveBeenCalled();
    expect((await second.resume(submitted.id)).status).toBe('running');
    expect(await second.runUntilSettled(source.tree,submitted.id)).toMatchObject({status:'succeeded',output:2});expect(source.execute).toHaveBeenCalledTimes(1);
    expect((await second.events(submitted.id)).map(event=>event.type)).toEqual(expect.arrayContaining(['run.paused','run.resumed']));
    await expect(second.pause(submitted.id)).rejects.toMatchObject({code:'CONFLICT'});await expect(second.resume(submitted.id)).rejects.toMatchObject({code:'CONFLICT'});
  });

  it('records child approval while paused and restores the unresolved review to waiting',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const source=fixture(undefined,true);
    const selected=runtime(store,async()=>({id:'reviewer',projectId:'project',canApprove:true}));const submitted=await selected.submit(source.tree,{input:1,idempotencyKey:'paused-child-approval'});
    const waiting=await selected.runUntilSettled(source.tree,submitted.id);expect(waiting.status).toBe('waiting');const childId=waiting.steps['child']!.child!.runId;
    const review=((await selected.inspectChild(submitted.id,childId)).steps['work']!.approval as {digest:string}).digest;
    await selected.pause(submitted.id);expect((await selected.resume(submitted.id)).status).toBe('waiting');
    await selected.pause(submitted.id);expect((await selected.approve({id:submitted.id,childId,nodeId:'work',digest:review,credential:'trusted'})).status).toBe('paused');
    expect((await selected.runUntilSettled(source.tree,submitted.id)).status).toBe('paused');expect(source.execute).not.toHaveBeenCalled();
    await selected.resume(submitted.id);expect(await selected.runUntilSettled(source.tree,submitted.id)).toMatchObject({status:'succeeded',output:2});expect(source.execute).toHaveBeenCalledTimes(1);
  });

  it('records root approval while paused and fences child scheduling at the root',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const execute=vi.fn(async(value:number)=>value+1);
    const tool=defineTool({id:'increment',version:'1',description:'Increment a number.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:2,execute});
    const tree=defineWorkflowTree({id:'paused-root-approval',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'work',tool,input:{kind:'input',path:[]},approval:true}],result:{kind:'step',stepId:'work',path:[]}});
    const selected=runtime(store,async()=>({id:'reviewer',projectId:'project',canApprove:true}));const submitted=await selected.submit(tree,{input:1,idempotencyKey:'paused-root-approval'});
    const waiting=await selected.runUntilSettled(tree,submitted.id);const review=(waiting.steps['work']!.approval as {digest:string}).digest;
    await selected.pause(submitted.id);expect((await selected.approve({id:submitted.id,nodeId:'work',digest:review,credential:'trusted'})).status).toBe('paused');
    expect((await selected.runUntilSettled(tree,submitted.id)).status).toBe('paused');expect(execute).not.toHaveBeenCalled();
    expect((await selected.resume(submitted.id)).status).toBe('running');expect(await selected.runUntilSettled(tree,submitted.id)).toMatchObject({status:'succeeded',output:2});

    const source=fixture();const childRoot=await selected.submit(source.tree,{input:1,idempotencyKey:'paused-child-prepare'});const scopeKey=digest('mayura:scope:v1',scope);
    const access={scope:scopeKey,rootId:childRoot.id,rootPolicyHash:(await store.read(scopeKey,childRoot.id))!.state['policy'] as string};
    const admitted=await store.workflowTrees.admitChild({...access,parentId:childRoot.id,nodeId:'child',expectedVersion:childRoot.version,input:1});
    await store.workflowTrees.pauseRoot!({...access,expectedVersion:admitted.root.record.version});
    await expect(store.workflowTrees.prepareChildTool({...access,childId:admitted.childId,childPolicyHash:admitted.policyHash,nodeId:'work',
      expectedVersion:admitted.child.version,input:1})).rejects.toMatchObject({code:'CONFLICT'});
    expect(source.execute).not.toHaveBeenCalled();
  });

  it('refuses a pause while a root effect is in flight and fences claims while paused',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
    const execute=vi.fn(async(value:number)=>{started();await released;return value+1;});
    const tool=defineTool({id:'increment',version:'1',description:'Increment a number.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:2,execute});
    const tree=defineWorkflowTree({id:'paused-root-tool',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'work',tool,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]}});
    const selected=runtime(store);const inFlight=await selected.submit(tree,{input:1,idempotencyKey:'pause-in-flight'});const execution=selected.runUntilSettled(tree,inFlight.id);await entered;
    await expect(selected.pause(inFlight.id)).rejects.toMatchObject({code:'CONFLICT'});release();expect((await execution).status).toBe('succeeded');

    const fenced=await selected.submit(tree,{input:1,idempotencyKey:'pause-fenced'});const scopeKey=digest('mayura:scope:v1',scope);
    const access={scope:scopeKey,rootId:fenced.id,rootPolicyHash:(await store.read(scopeKey,fenced.id))!.state['policy'] as string};
    const prepared=await store.workflowTrees.prepareRootTool({...access,nodeId:'work',expectedVersion:fenced.version,input:1});
    const pausedRoot=await store.workflowTrees.pauseRoot!({...access,expectedVersion:prepared.root.record.version});expect(pausedRoot.record.state['status']).toBe('paused');
    expect(await store.workflowTrees.claimPreparedRootTool({...access,nodeId:'work',workerId:'fenced-worker',leaseMs:60_000})).toBeUndefined();
    await expect(store.workflowTrees.finalizeRoot({...access,expectedVersion:pausedRoot.record.version,output:2})).rejects.toMatchObject({code:'CONFLICT'});
    expect((await selected.resume(fenced.id)).status).toBe('running');expect(await selected.runUntilSettled(tree,fenced.id)).toMatchObject({status:'succeeded',output:2});

    const claimed=await selected.submit(tree,{input:3,idempotencyKey:'pause-claimed'});const claimedAccess={...access,rootId:claimed.id};
    const preparedClaim=await store.workflowTrees.prepareRootTool({...claimedAccess,nodeId:'work',expectedVersion:claimed.version,input:3});
    expect(await store.workflowTrees.claimPreparedRootTool({...claimedAccess,nodeId:'work',workerId:'claimant',leaseMs:60_000})).toBeDefined();
    await expect(store.workflowTrees.pauseRoot!({...claimedAccess,expectedVersion:preparedClaim.root.record.version+1})).rejects.toMatchObject({code:'CONFLICT'});
    await expect(selected.pause(claimed.id)).rejects.toMatchObject({code:'CONFLICT'});

    const cancelled=await selected.submit(tree,{input:5,idempotencyKey:'pause-cancel'});await selected.pause(cancelled.id);
    expect(await selected.cancel(cancelled.id)).toMatchObject({status:'cancelled',steps:{work:{status:'skipped'}}});expect(execute).toHaveBeenCalledTimes(2);
  });

  it('drains an admitted root effect and admits no child',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
    const execute=vi.fn(async(value:number)=>{started();await released;return value+1;});const tool=defineTool({id:'increment',version:'1',description:'Increment a number.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:1,execute});
    const source=fixture();const leafNode=source.tree.nodes[0]!;
    const tree=defineWorkflowTree({id:'drained-tree',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'first',tool,input:{kind:'input',path:[]}},{...leafNode,dependsOn:['first']}],result:{kind:'step',stepId:'first',path:[]}});
    const options={store,scope,permissions:{allow:['tool:increment']},policyVersion:'1',maxCostMicros:3,maxCalls:2,maxOutputBytes:1_024,leaseMs:3_000};
    const selected=createWorkflowTreeRuntime({...options,workerId:'worker'});runtimes.push(selected);
    const submitted=await selected.submit(tree,{input:1,idempotencyKey:'drained-tree'});const execution=selected.runUntilSettled(tree,submitted.id).catch(()=>undefined);await entered;
    const draining=selected.drain({timeoutMs:5_000});await expect(selected.runUntilSettled(tree,submitted.id)).rejects.toMatchObject({code:'CANCELLED'});
    release();expect(await draining).toEqual({drained:true,interrupted:0});await execution;
    const observer=createWorkflowTreeRuntime({...options,workerId:'observer'});runtimes.push(observer);
    expect(await observer.inspect(submitted.id)).toMatchObject({steps:{first:{status:'succeeded'},child:{status:'pending',child:null}}});expect(execute).toHaveBeenCalledTimes(1);expect(source.execute).not.toHaveBeenCalled();
  });

  it('shares bounded execution capacity across ready root and child branches',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();let active=0;let peak=0;let arrivals=0;let release!:()=>void;const bothStarted=new Promise<void>(resolve=>{release=resolve;});const execute=vi.fn(async(value:number)=>{active++;peak=Math.max(peak,active);arrivals++;if(arrivals===2)release();await bothStarted;active--;return value+1;});const tool=defineTool({id:'parallel-increment',version:'1',description:'Increment concurrently.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:1,execute});const leaf=defineWorkflow({id:'parallel-leaf',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'childWork',tool,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'childWork',path:[]}});const tree=defineWorkflowTree({id:'parallel-tree',version:'1',input:z.number(),output:z.array(z.number()),nodes:[{kind:'tool',id:'rootWork',tool,input:{kind:'input',path:[]}},{kind:'child',id:'child',workflow:leaf,input:{kind:'input',path:[]},policy:{permissions:['tool:parallel-increment'],maxCostMicros:1,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{childWork:[]}},{kind:'join',id:'joined',dependsOn:['rootWork','child']}],result:{kind:'step',stepId:'joined',path:[]}});const selected=createWorkflowTreeRuntime({store,scope,permissions:{allow:['tool:parallel-increment']},policyVersion:'1',maxCostMicros:2,maxCalls:2,maxOutputBytes:1_024,workerId:'parallel-worker',leaseMs:3_000,maxConcurrentJobs:2});runtimes.push(selected);const submitted=await selected.submit(tree,{input:1,idempotencyKey:'parallel'});const finished=await selected.runUntilSettled(tree,submitted.id);expect(finished).toMatchObject({status:'succeeded',output:[2,2]});expect(peak).toBe(2);expect(execute).toHaveBeenCalledTimes(2);
  });

  it('serializes ready branches when the shared job limit is one',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();let active=0;let peak=0;const execute=vi.fn(async(value:number)=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,20));active--;return value+1;});const tool=defineTool({id:'serial-increment',version:'1',description:'Increment serially.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:1,execute});const tree=defineWorkflowTree({id:'serial-tree',version:'1',input:z.number(),output:z.array(z.number()),nodes:[{kind:'tool',id:'left',tool,input:{kind:'input',path:[]}},{kind:'tool',id:'right',tool,input:{kind:'input',path:[]}},{kind:'join',id:'joined',dependsOn:['left','right']}],result:{kind:'step',stepId:'joined',path:[]}});const selected=createWorkflowTreeRuntime({store,scope,permissions:{allow:['tool:serial-increment']},policyVersion:'1',maxCostMicros:2,maxCalls:2,maxOutputBytes:1_024,workerId:'serial-worker',leaseMs:3_000,maxConcurrentJobs:1});runtimes.push(selected);const submitted=await selected.submit(tree,{input:1,idempotencyKey:'serial'});const finished=await selected.runUntilSettled(tree,submitted.id);expect(finished).toMatchObject({status:'succeeded',output:[2,2]});expect(peak).toBe(1);expect(execute).toHaveBeenCalledTimes(2);
  });

  it('retains shared capacity until a timed-out handler actually settles',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();let release!:()=>void;let settled!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const handlerSettled=new Promise<void>(resolve=>{settled=resolve;});const slow=defineTool({id:'slow',version:'1',description:'Settle after timeout.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:1,timeoutMs:25,execute:async value=>{await gate;settled();return value;}});const fastExecute=vi.fn(async(value:number)=>value);const fast=defineTool({id:'fast',version:'1',description:'Run after capacity returns.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:1,execute:fastExecute});const slowTree=defineWorkflowTree({id:'slow-tree',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'work',tool:slow,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]}});const fastTree=defineWorkflowTree({id:'fast-tree',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'work',tool:fast,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]}});const selected=createWorkflowTreeRuntime({store,scope,permissions:{allow:['tool:slow','tool:fast']},policyVersion:'1',maxCostMicros:1,maxCalls:1,maxOutputBytes:1_024,workerId:'capacity-worker',leaseMs:3_000,maxConcurrentJobs:1,maxConcurrentRuns:2});runtimes.push(selected);const slowRun=await selected.submit(slowTree,{input:1,idempotencyKey:'slow'});const slowResult=await selected.runUntilSettled(slowTree,slowRun.id);expect(slowResult.status).toBe('outcome_unknown');const fastRun=await selected.submit(fastTree,{input:2,idempotencyKey:'fast'});const waiting=await selected.runUntilSettled(fastTree,fastRun.id);expect(waiting.status).toBe('running');expect(fastExecute).not.toHaveBeenCalled();release();await handlerSettled;await new Promise(resolve=>setTimeout(resolve,0));const finished=await selected.runUntilSettled(fastTree,fastRun.id);expect(finished).toMatchObject({status:'succeeded',output:2});expect(fastExecute).toHaveBeenCalledTimes(1);
  });

  it('coordinates competing runtimes without replaying one root tool',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const execute=vi.fn(async(value:number)=>{await new Promise(resolve=>setTimeout(resolve,30));return value+1;});const tool=defineTool({id:'contended-increment',version:'1',description:'Increment once.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:1,execute});const tree=defineWorkflowTree({id:'contended-tree',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'work',tool,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]}});const options={store,scope,permissions:{allow:['tool:contended-increment']},policyVersion:'1',maxCostMicros:1,maxCalls:1,maxOutputBytes:1_024,leaseMs:3_000} as const;const first=createWorkflowTreeRuntime({...options,workerId:'contender-a'});const second=createWorkflowTreeRuntime({...options,workerId:'contender-b'});runtimes.push(first,second);const submitted=await first.submit(tree,{input:1,idempotencyKey:'contended'});await Promise.all([first.runUntilSettled(tree,submitted.id),second.runUntilSettled(tree,submitted.id)]);const current=await first.inspect(submitted.id);const finished=current.status==='succeeded'?current:await second.runUntilSettled(tree,submitted.id);expect(finished).toMatchObject({status:'succeeded',output:2});expect(execute).toHaveBeenCalledTimes(1);
  });
});
