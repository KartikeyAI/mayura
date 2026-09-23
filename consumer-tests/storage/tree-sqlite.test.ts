import type { Schema } from '@mayura/core';
import type { WorkflowTreeAggregateStore } from '@mayura/storage-contracts';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { defineTool } from '@mayura/tools';
import { defineWorkflow } from '@mayura/workflows';
import { createWorkflowTreeRuntime, defineWorkflowTree } from '@mayura/workflows/children';

const numberSchema:Schema<number>={'~standard':{version:1,vendor:'packed-types',validate:value=>typeof value==='number'?{value}:{issues:[{message:'number'}]}}};
const increment=defineTool({id:'increment',version:'1',description:'Increment.',input:numberSchema,output:numberSchema,effects:'none',capabilities:[],costMicros:1,execute:async value=>value+1});
const leaf=defineWorkflow({id:'leaf',version:'1',input:numberSchema,output:numberSchema,nodes:[{kind:'tool',id:'work',tool:increment,input:{kind:'input',path:[]},approval:true}],result:{kind:'step',stepId:'work',path:[]}});
const tree=defineWorkflowTree({id:'tree',version:'1',input:numberSchema,output:numberSchema,nodes:[{kind:'child',id:'child',workflow:leaf,input:{kind:'input',path:[]},policy:{permissions:['tool:increment'],maxCostMicros:1,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{work:[]}}],result:{kind:'step',stepId:'child',path:[]}});
const store:WorkflowTreeAggregateStore=createSqliteStore({filename:':memory:'});
const runtime=createWorkflowTreeRuntime({store,scope:{principalId:'consumer',projectId:'types'},permissions:{allow:['tool:increment']},policyVersion:'1',maxCostMicros:1,maxCalls:1,workerId:'worker',verifyHuman:async()=>({id:'reviewer',projectId:'types',canApprove:true})});
void runtime.submit(tree,{input:1,idempotencyKey:'tree'});
void runtime.inspectChild('0'.repeat(64),'1'.repeat(64));
void runtime.approve({id:'0'.repeat(64),nodeId:'rootWork',digest:'2'.repeat(64),credential:{token:'application-owned'}});
void runtime.approve({id:'0'.repeat(64),childId:'1'.repeat(64),nodeId:'work',digest:'2'.repeat(64),credential:{token:'application-owned'}});
// @ts-expect-error A workflow tree requires an aggregate store with the explicit optional capability.
createWorkflowTreeRuntime({store:{initialize:store.initialize,create:store.create,read:store.read,update:store.update,events:store.events,close:store.close},scope:{principalId:'consumer',projectId:'types'},permissions:{allow:[]},policyVersion:'1',maxCostMicros:1,maxCalls:1,workerId:'worker'});
