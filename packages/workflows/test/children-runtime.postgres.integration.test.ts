import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createPostgresStore } from '@mayura/storage';
import { createWorkflowTreeRuntime, defineWorkflowTree } from '../src/children.js';
import { defineWorkflow } from '../src/definition.js';

const connectionString=process.env['MAYURA_TEST_POSTGRES_URL'];const suite=connectionString?describe:describe.skip;

suite('PostgreSQL workflow-tree developer runtime',()=>{
  it('executes and reopens a required child through the selected adapter',async()=>{
    const schema=`mayura_tree_runtime_${randomUUID().replaceAll('-','')}`;const open=()=>createPostgresStore({connectionString:connectionString!,schema});const stores=[open()];const runtimes:ReturnType<typeof createWorkflowTreeRuntime>[]=[];
    try{const execute=async(value:number)=>value+1;const tool=defineTool({id:'increment',version:'1',description:'Increment.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:2,execute});const leaf=defineWorkflow({id:'leaf',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'work',tool,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]}});const tree=defineWorkflowTree({id:'tree',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'child',id:'child',workflow:leaf,input:{kind:'input',path:[]},policy:{permissions:['tool:increment'],maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{work:[]}}],result:{kind:'step',stepId:'child',path:[]}});const options={scope:{principalId:'runtime',projectId:'project'},permissions:{allow:['tool:increment']},policyVersion:'1',maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,workerId:'worker'} as const;await stores[0]!.initialize();const first=createWorkflowTreeRuntime({store:stores[0]!,...options});runtimes.push(first);const submitted=await first.submit(tree,{input:1,idempotencyKey:'root'});await first.close();runtimes.splice(0);const reopened=open();stores.push(reopened);await reopened.initialize();const second=createWorkflowTreeRuntime({store:reopened,...options});runtimes.push(second);const finished=await second.runUntilSettled(tree,submitted.id);expect(finished).toMatchObject({status:'succeeded',output:2});expect(await second.inspect(submitted.id)).toEqual(finished);
    }finally{await Promise.all(runtimes.map(runtime=>runtime.close()));await Promise.all(stores.map(store=>store.close()));if(!/^mayura_tree_runtime_[a-f0-9]{32}$/.test(schema))throw new Error('Unexpected fixture schema.');const pool=new Pool({connectionString:connectionString!});try{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await pool.end();}}
  });
});
