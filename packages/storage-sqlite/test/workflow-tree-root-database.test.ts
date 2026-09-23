import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  DurableBudgetDatabase, ScheduledWorkflowDatabase, SchedulerDatabase, WorkflowTreeDatabase,
  type SchedulerBackend, type SchedulerSession,
} from '@mayura/storage-sql/host';
import type { WorkflowTreeManifest, WorkflowTreePolicyManifest } from '@mayura/storage-contracts';
import { workflowTreeState } from '@mayura/storage-contracts';

function backend(database:Database.Database):SchedulerBackend{
  const session:SchedulerSession={query:async<T>(sql:string,parameters:readonly unknown[]=[])=>{const statement=database.prepare(sql);if(statement.reader)return statement.all(...parameters) as T[];statement.run(...parameters);return[];}};
  return{dialect:'sqlite',prefix:'',transaction:async body=>{database.exec('BEGIN IMMEDIATE');try{const value=await body(session);database.exec('COMMIT');return value;}catch(error){database.exec('ROLLBACK');throw error;}}};
}
function base(database:Database.Database):void{database.pragma('foreign_keys = ON');database.exec(`
  CREATE TABLE mayura_aggregates (scope TEXT NOT NULL,id TEXT NOT NULL,idempotency_key TEXT NOT NULL,definition_hash TEXT NOT NULL,submission_digest TEXT NOT NULL,version INTEGER NOT NULL,event_sequence INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(scope,id),UNIQUE(scope,idempotency_key));
  CREATE TABLE mayura_events (scope TEXT NOT NULL,aggregate_id TEXT NOT NULL,sequence INTEGER NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scope,aggregate_id,sequence),FOREIGN KEY(scope,aggregate_id) REFERENCES mayura_aggregates(scope,id));
  CREATE TABLE mayura_workflow_owners (scope TEXT NOT NULL,aggregate_id TEXT NOT NULL,profile INTEGER NOT NULL,aggregate_version INTEGER NOT NULL,definition_hash TEXT NOT NULL,policy_hash TEXT NOT NULL,resource_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,aggregate_id),FOREIGN KEY(scope,aggregate_id) REFERENCES mayura_aggregates(scope,id));`);}
const leaf={id:'leaf',version:'1',graph:[{kind:'tool' as const,id:'work',dependsOn:[],tool:'fixture/tool',toolVersion:'1',effects:'none' as const,capabilities:[],costMicros:2,approval:false,input:{kind:'input' as const,path:[]}}],result:{kind:'step' as const,stepId:'work',path:[]}};
const manifest:WorkflowTreeManifest={format:4,id:'root',version:'1',graph:[{kind:'child',id:'child',dependsOn:[],workflow:leaf,policy:{permissions:['tool:fixture/tool'],maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{work:[]},input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'child',path:[]}};
const policy:WorkflowTreePolicyManifest={scope:{principalId:'owner',projectId:'project'},permissions:['tool:fixture/tool'],policyVersion:'1',maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000};

describe('workflow-tree atomic root enrollment',()=>{
  it('commits one profile-3 root, membership and scheduler-owned ledger and retries exactly',async()=>{
    const database=new Database(':memory:');base(database);const selected=backend(database);const scheduler=new SchedulerDatabase(selected);const trees=new WorkflowTreeDatabase(selected,scheduler);
    await trees.initialize();const first=await trees.submit({manifest,policy,resources:{},input:{value:1},idempotencyKey:'one'});const second=await trees.submit({manifest,policy,resources:{},input:{value:1},idempotencyKey:'one'});
    expect(first.created).toBe(true);expect(second.created).toBe(false);expect(second.snapshot).toEqual(first.snapshot);expect(first.snapshot).toMatchObject({profile:'scheduled-v3',accountId:'root',budget:{owner:'workflow-tree-v1',accounts:[{id:'root',maxCostMicros:2,maxCalls:1}]}});
    expect(database.prepare('SELECT profile FROM mayura_workflow_owners').pluck().all()).toEqual([3]);expect(database.prepare('SELECT account_id FROM mayura_workflow_tree_members').pluck().all()).toEqual(['root']);
    const legacy=new ScheduledWorkflowDatabase(selected,scheduler);await legacy.execute('initialize',{});await expect(legacy.execute('inspect',{scope:first.snapshot.record.scope,id:first.snapshot.rootId,policyHash:first.snapshot.policyHash})).rejects.toMatchObject({code:'CONFLICT'});
    const host=new DurableBudgetDatabase(selected);await host.execute('initialize',{});await expect(host.execute('inspect',{scope:first.snapshot.record.scope,id:first.snapshot.rootId,policyHash:first.snapshot.policyHash})).resolves.toBeUndefined();database.close();
  });

  it('rolls back ledger and aggregate when the final membership write fails',async()=>{
    const database=new Database(':memory:');base(database);const selected=backend(database);const trees=new WorkflowTreeDatabase(selected,new SchedulerDatabase(selected));await trees.initialize();
    database.exec("CREATE TRIGGER reject_tree_member BEFORE INSERT ON mayura_workflow_tree_members BEGIN SELECT RAISE(ABORT, 'rejected'); END;");
    await expect(trees.submit({manifest,policy,resources:{},input:null,idempotencyKey:'rollback'})).rejects.toBeDefined();
    expect(database.prepare('SELECT COUNT(*) FROM mayura_aggregates').pluck().get()).toBe(0);expect(database.prepare('SELECT COUNT(*) FROM mayura_workflow_tree_budgets').pluck().get()).toBe(0);expect(database.prepare('SELECT COUNT(*) FROM mayura_workflow_tree_budget_events').pluck().get()).toBe(0);database.close();
  });

  it('rejects widened child authority and an impossible required plan before persistence',async()=>{
    const database=new Database(':memory:');base(database);const trees=new WorkflowTreeDatabase(backend(database),new SchedulerDatabase(backend(database)));await trees.initialize();
    const original=manifest.graph[0]!;if(original.kind!=='child')throw new Error('fixture');
    const widened={...manifest,graph:[{...original,policy:{...original.policy,permissions:['host:admin']}}]} as WorkflowTreeManifest;
    await expect(trees.submit({manifest:widened,policy,resources:{},input:null,idempotencyKey:'wide'})).rejects.toBeDefined();
    await expect(trees.submit({manifest,policy:{...policy,maxCostMicros:1},resources:{},input:null,idempotencyKey:'small'})).rejects.toBeDefined();
    expect(database.prepare('SELECT COUNT(*) FROM mayura_aggregates').pluck().get()).toBe(0);database.close();
  });

  it('admits exactly one derived child and account with semantic retry',async()=>{
    const database=new Database(':memory:');base(database);const selected=backend(database);const trees=new WorkflowTreeDatabase(selected,new SchedulerDatabase(selected));await trees.initialize();
    const submitted=await trees.submit({manifest,policy,resources:{},input:{value:1},idempotencyKey:'root'});const root=submitted.snapshot;
    const admitted=await trees.admitChild({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,parentId:root.rootId,nodeId:'child',expectedVersion:root.record.version,input:{value:1}});
    expect(admitted.created).toBe(true);expect(admitted.root).toMatchObject({record:{version:2},budget:{version:2}});expect(admitted.root.budget.accounts).toEqual(expect.arrayContaining([expect.objectContaining({id:'root'}),expect.objectContaining({id:admitted.accountId,parentId:'root'})]));
    expect(workflowTreeState(admitted.child)).toMatchObject({format:4,rootId:root.rootId,accountId:admitted.accountId,budgetVersion:2});
    const retry=await trees.admitChild({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,parentId:root.rootId,nodeId:'child',expectedVersion:root.record.version,input:{value:1}});expect(retry.created).toBe(false);expect(retry.childId).toBe(admitted.childId);
    await expect(trees.admitChild({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,parentId:root.rootId,nodeId:'child',expectedVersion:2,input:{value:2}})).rejects.toMatchObject({code:'CONFLICT'});
    expect(database.prepare('SELECT COUNT(*) FROM mayura_workflow_owners').pluck().get()).toBe(2);expect(database.prepare('SELECT COUNT(*) FROM mayura_workflow_tree_members').pluck().get()).toBe(2);database.close();
  });

  it('rolls child account, aggregate and parent transition back together',async()=>{
    const database=new Database(':memory:');base(database);const selected=backend(database);const trees=new WorkflowTreeDatabase(selected,new SchedulerDatabase(selected));await trees.initialize();
    const root=(await trees.submit({manifest,policy,resources:{},input:null,idempotencyKey:'root'})).snapshot;
    database.exec("CREATE TRIGGER reject_child_member BEFORE INSERT ON mayura_workflow_tree_members WHEN NEW.account_id <> 'root' BEGIN SELECT RAISE(ABORT, 'rejected'); END;");
    await expect(trees.admitChild({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,parentId:root.rootId,nodeId:'child',expectedVersion:1,input:null})).rejects.toBeDefined();
    const reopened=await trees.inspect(root.record.scope,root.rootId,root.policyHash);expect(reopened).toMatchObject({record:{version:1},budget:{version:1,accounts:[{id:'root'}]}});expect(database.prepare('SELECT COUNT(*) FROM mayura_aggregates').pluck().get()).toBe(1);database.close();
  });

  it('atomically prepares one child tool with its shared-ledger ticket and scheduler job',async()=>{
    const database=new Database(':memory:');base(database);const selected=backend(database);const scheduler=new SchedulerDatabase(selected);const trees=new WorkflowTreeDatabase(selected,scheduler);await trees.initialize();
    const root=(await trees.submit({manifest,policy,resources:{},input:null,idempotencyKey:'root'})).snapshot;const child=await trees.admitChild({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,parentId:root.rootId,nodeId:'child',expectedVersion:1,input:null});
    const command={scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,childId:child.childId,childPolicyHash:child.policyHash,nodeId:'work',expectedVersion:1,input:null};
    const prepared=await trees.prepareChildTool(command);expect(prepared.created).toBe(true);expect(prepared.job).toMatchObject({state:'ready',runId:child.childId,nodeId:'work'});expect(prepared.root).toMatchObject({record:{version:3},budget:{version:3}});expect(prepared.root.budget.accounts.find(account=>account.id===child.accountId)).toMatchObject({reservedMicros:2,heldCalls:1});expect(workflowTreeState(prepared.member)).toMatchObject({budgetVersion:3,reservedMicros:2,steps:{work:{candidateHash:expect.stringMatching(/^[a-f0-9]{64}$/),costReserved:2}}});
    const retry=await trees.prepareChildTool(command);expect(retry.created).toBe(false);expect(retry.job.jobId).toBe(prepared.job.jobId);await expect(trees.prepareChildTool({...command,input:{changed:true},expectedVersion:2})).rejects.toMatchObject({code:'CONFLICT'});
    const claimed=await trees.claimPreparedChildTool({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,childId:child.childId,childPolicyHash:child.policyHash,nodeId:'work',workerId:'worker-a',leaseMs:1_000});expect(claimed).toMatchObject({job:{state:'leased',workerId:'worker-a',fence:1},claim:{workerId:'worker-a',fence:1},member:{version:3}});await expect(trees.claimPreparedChildTool({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,childId:child.childId,childPolicyHash:child.policyHash,nodeId:'work',workerId:'worker-b',leaseMs:1_000})).resolves.toBeUndefined();
    await expect(scheduler.execute('claim',{scope:root.record.scope,workerId:'legacy',limit:1,leaseMs:1_000})).resolves.toEqual([]);database.close();
  });

  it('rolls a financial hold and scheduler reservation back when job linkage fails',async()=>{
    const database=new Database(':memory:');base(database);const selected=backend(database);const trees=new WorkflowTreeDatabase(selected,new SchedulerDatabase(selected));await trees.initialize();const root=(await trees.submit({manifest,policy,resources:{},input:null,idempotencyKey:'root'})).snapshot;const child=await trees.admitChild({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,parentId:root.rootId,nodeId:'child',expectedVersion:1,input:null});
    database.exec("CREATE TRIGGER reject_tree_job BEFORE INSERT ON mayura_workflow_tree_jobs BEGIN SELECT RAISE(ABORT, 'rejected'); END;");await expect(trees.prepareChildTool({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,childId:child.childId,childPolicyHash:child.policyHash,nodeId:'work',expectedVersion:1,input:null})).rejects.toBeDefined();
    const current=await trees.inspect(root.record.scope,root.rootId,root.policyHash);expect(current).toMatchObject({record:{version:2},budget:{version:2,reservations:[]}});expect(database.prepare('SELECT COUNT(*) FROM mayura_scheduler_jobs').pluck().get()).toBe(0);database.close();
  });
});
