import { describe,expect,it } from 'vitest';
import type { WorkflowTreeDiscoveryAggregateStore } from '@mayura/storage-contracts';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createWorkflowTreeCoordinator,createWorkflowTreeRuntime,defineWorkflowTree } from '../src/children.js';

/** A disposable database: `open()` returns a new store over it, `cleanup()` removes it. */
export interface TreeFixture { open(): WorkflowTreeDiscoveryAggregateStore; cleanup(): Promise<void> }

/** Competing workflow-tree coordinators on one store dispatch each tool once. */
export function workflowTreeCoordinatorConformance(name: string, factory: () => Promise<TreeFixture>): void {
describe(`${name} workflow-tree coordinator`,()=>{
  it('fences competing coordinators to one dispatch',async()=>{const fixture=await factory();const stores=[fixture.open(),fixture.open()];const closers:{close():Promise<void>}[]=[];try{await Promise.all(stores.map(store=>store.initialize()));let executions=0;const tool=defineTool({id:'coordinated',version:'1',description:'Coordinate once.',input:z.number(),output:z.number(),effects:'none',capabilities:[],costMicros:1,execute:async value=>{executions++;await new Promise(resolve=>setTimeout(resolve,25));return value+1;}});const tree=defineWorkflowTree({id:'coordinated-tree',version:'1',input:z.number(),output:z.number(),nodes:[{kind:'tool',id:'work',tool,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]}});const shared={scope:{principalId:'coordinator',projectId:'project'},permissions:{allow:['tool:coordinated']},policyVersion:'1',maxCostMicros:1,maxCalls:1,maxOutputBytes:1_024} as const;const submitter=createWorkflowTreeRuntime({store:stores[0]!,...shared,workerId:'submitter'});const submitted=await submitter.submit(tree,{input:1,idempotencyKey:'one'});await submitter.close();const first=createWorkflowTreeCoordinator({store:stores[0]!,...shared,workerId:'coordinator-a',definitions:[tree]});const second=createWorkflowTreeCoordinator({store:stores[1]!,...shared,workerId:'coordinator-b',definitions:[tree]});closers.push(first,second);const reports=await Promise.all([first.runPage({limit:32}),second.runPage({limit:32})]);expect(reports.every(report=>report.status==='completed')).toBe(true);expect(reports.flatMap(report=>report.outcomes).some(outcome=>outcome.kind==='observed'&&outcome.rootId===submitted.id&&outcome.status==='succeeded')).toBe(true);expect(executions).toBe(1);
    }finally{await Promise.all(closers.map(item=>item.close()));await Promise.all(stores.map(store=>store.close()));await fixture.cleanup();}},15_000);
});
}
