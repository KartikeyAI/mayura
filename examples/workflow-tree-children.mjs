import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { defineTool } from '@mayura/tools';
import { defineWorkflow } from '@mayura/workflows';
import { createWorkflowTreeRuntime, defineWorkflowTree } from '@mayura/workflows/children';

const numberSchema=Object.freeze({'~standard':Object.freeze({version:1,vendor:'mayura-example',validate:value=>typeof value==='number'?{value}:{issues:[{message:'number required'}]}})});
let executions=0;
const increment=defineTool({id:'example.increment',version:'1',description:'Increment a number.',input:numberSchema,output:numberSchema,effects:'none',capabilities:[],costMicros:1,execute:async value=>{executions++;return value+1;}});
const child=defineWorkflow({id:'example.child',version:'1',input:numberSchema,output:numberSchema,nodes:[{kind:'tool',id:'increment',tool:increment,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'increment',path:[]}});
const tree=defineWorkflowTree({id:'example.tree',version:'1',input:numberSchema,output:numberSchema,nodes:[{kind:'child',id:'required',workflow:child,input:{kind:'input',path:[]},policy:{permissions:['tool:example.increment'],maxCostMicros:1,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{increment:[]}}],result:{kind:'step',stepId:'required',path:[]}});
const options={scope:{principalId:'example',projectId:'workflow-tree'},permissions:{allow:['tool:example.increment']},policyVersion:'1',maxCostMicros:1,maxCalls:1,maxOutputBytes:1_024,workerId:'example-worker'};
const directory=await mkdtemp(join(tmpdir(),'mayura-workflow-tree-example-'));const filename=join(directory,'tree.sqlite');let store;let runtime;
try{
  store=createSqliteStore({filename});await store.initialize();runtime=createWorkflowTreeRuntime({store,...options});const submitted=await runtime.submit(tree,{input:41,idempotencyKey:'example-tree'});await runtime.close();runtime=undefined;await store.close();store=undefined;
  store=createSqliteStore({filename});await store.initialize();runtime=createWorkflowTreeRuntime({store,...options});const finished=await runtime.runUntilSettled(tree,submitted.id);if(finished.status!=='succeeded'||finished.output!==42||executions!==1)throw new Error('Required-child continuation failed.');
  console.log(JSON.stringify({status:finished.status,output:finished.output,toolExecutions:executions,rootAccountClosed:finished.budget.accounts.find(account=>account.id==='root')?.closed}));
}finally{
  await runtime?.close();await store?.close();const cleanup=resolve(directory);if(!cleanup.startsWith(`${resolve(tmpdir())}${sep}mayura-workflow-tree-example-`))throw new Error('Unexpected example fixture path.');await rm(cleanup,{recursive:true,force:true});
}
