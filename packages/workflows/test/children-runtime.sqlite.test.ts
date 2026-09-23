import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage';
import { createWorkflowTreeRuntime, defineWorkflowTree } from '../src/children.js';
import { defineWorkflow } from '../src/definition.js';

const scope={principalId:'tree-runtime',projectId:'project'};
const stores:ReturnType<typeof createSqliteStore>[]=[];const runtimes:ReturnType<typeof createWorkflowTreeRuntime>[]=[];
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(runtime=>runtime.close()));await Promise.all(stores.splice(0).map(store=>store.close()));});

function fixture(permissions:readonly string[]=['tool:increment']){
  const execute=vi.fn(async(value:number)=>value+1);const tool=defineTool({id:'increment',version:'1',description:'Increment a number.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:2,execute});const leaf=defineWorkflow({id:'leaf',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'work',tool,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]}});const tree=defineWorkflowTree({id:'tree',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'child',id:'child',workflow:leaf,input:{kind:'input',path:[]},policy:{permissions,maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{work:[]}}],result:{kind:'step',stepId:'child',path:[]}});return{execute,tree};
}
function runtime(store:ReturnType<typeof createSqliteStore>){const value=createWorkflowTreeRuntime({store,scope,permissions:{allow:['tool:increment']},policyVersion:'1',maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,workerId:'worker',leaseMs:3_000});runtimes.push(value);return value;}

describe('workflow-tree developer runtime',()=>{
  it('resumes a submitted tree in another runtime and completes one required child exactly once',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const source=fixture();const first=runtime(store);const submitted=await first.submit(source.tree,{input:1,idempotencyKey:'root'});expect(submitted.status).toBe('running');await first.close();runtimes.splice(runtimes.indexOf(first),1);const second=runtime(store);const finished=await second.runUntilSettled(source.tree,submitted.id);expect(finished).toMatchObject({status:'succeeded',output:2,budget:{accounts:expect.arrayContaining([expect.objectContaining({id:'root',closed:true,spentMicros:2,calls:1})])}});expect(source.execute).toHaveBeenCalledTimes(1);expect(await second.inspect(submitted.id)).toEqual(finished);
  });

  it('fails closed before dispatch when the narrowed child omits its tool grant',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const source=fixture([]);const selected=runtime(store);const submitted=await selected.submit(source.tree,{input:1,idempotencyKey:'denied'});const finished=await selected.runUntilSettled(source.tree,submitted.id);expect(finished.status).toBe('failed');expect(finished.output).toBeNull();expect(finished.budget.accounts.find(account=>account.id==='root')).toMatchObject({closed:true,spentMicros:0,calls:0});expect(source.execute).not.toHaveBeenCalled();
  });

  it('rejects root-local tools until their atomic format-4 commands are available',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();const source=fixture();const rootTool=source.tree.nodes[0]!.kind==='child'?source.tree.nodes[0]!.workflow.nodes[0]:undefined;if(!rootTool||rootTool.kind!=='tool')throw new Error('fixture');const unsupported=defineWorkflowTree({id:'unsupported',version:'1',input:z.number(),output:z.number(),nodes:[rootTool],result:{kind:'step',stepId:'work',path:[]}});const selected=runtime(store);await expect(selected.submit(unsupported,{input:1,idempotencyKey:'unsupported'})).rejects.toMatchObject({code:'UNSUPPORTED_PROFILE'});expect(await store.read('unused','unused')).toBeUndefined();
  });
});
