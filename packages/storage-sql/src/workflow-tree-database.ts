import { createHash } from 'node:crypto';
import { jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import {
  StorageError, assertWorkflowTreeRootState, initialWorkflowTreeLeafState, initialWorkflowTreeRootState, workflowHashMaterial,
  workflowTreeManifest, workflowTreePolicy, workflowTreeRootResources, workflowTreeState,
  type StoredRecord, type WorkflowResourcePlan, type WorkflowTreeManifest, type WorkflowTreePolicyManifest,
} from '@mayura/storage-contracts';
import {
  aggregateRecord, createAggregate, initializeOwnership, loadAggregate, lockRunIdentity, lockSql, storageClock, storedInteger, writeAggregate,
} from './aggregate-session.js';
import { WorkflowTreeBudgetDatabase } from './durable-budget-database.js';
import type { WorkflowTreeBudgetSnapshot } from './durable-budget-state.js';
import { createCommand, identifier } from './validation.js';
import { SchedulerDatabase, type SchedulerBackend, type SchedulerSession } from './scheduler-database.js';

interface OwnerRow { scope:string;aggregate_id:string;profile:number|string;aggregate_version:number|string;definition_hash:string;policy_hash:string;resource_hash:string;data:string }
interface MemberRow { scope:string;root_id:string;aggregate_id:string;parent_id:string|null;node_id:string|null;account_id:string;definition_hash:string;policy_hash:string;resource_hash:string }
interface RootOwner { format:4;rootId:string;manifest:WorkflowTreeManifest;policy:WorkflowTreePolicyManifest;resources:WorkflowResourcePlan }
interface ChildOwner { format:4;rootId:string;parentId:string;nodeId:string;accountId:string;manifest:import('@mayura/storage-contracts').WorkflowManifest;policy:WorkflowTreePolicyManifest;resources:WorkflowResourcePlan;inputHash:string }
export interface WorkflowTreeRootSubmission {
  readonly manifest:WorkflowTreeManifest;readonly policy:WorkflowTreePolicyManifest;readonly resources:WorkflowResourcePlan;
  readonly input:JsonValue;readonly idempotencyKey:string;
}
export interface WorkflowTreeRootSnapshot {
  readonly record:StoredRecord;readonly profile:'scheduled-v3';readonly rootId:string;readonly accountId:'root';
  readonly manifestHash:string;readonly policyHash:string;readonly resourceHash:string;readonly budget:WorkflowTreeBudgetSnapshot;
}
export interface WorkflowTreeChildAdmission {
  readonly root:WorkflowTreeRootSnapshot;readonly child:StoredRecord;readonly childId:string;readonly accountId:string;
  readonly definitionHash:string;readonly policyHash:string;readonly resourceHash:string;readonly inputHash:string;readonly created:boolean;
}
function digest(domain:string,value:unknown):string{return createHash('sha256').update(workflowHashMaterial(domain,value)).digest('hex');}
function same(left:unknown,right:unknown):boolean{return workflowHashMaterial('compare',left)===workflowHashMaterial('compare',right);}
function failed():never{throw new StorageError('STORAGE_UNAVAILABLE','Stored workflow tree failed integrity validation.');}
function conflict():never{throw new StorageError('CONFLICT','Workflow-tree identity or immutable content changed.');}

/** Atomic root enrollment foundation. Execution transitions remain deliberately unavailable. */
export class WorkflowTreeDatabase {
  private initialized=false;
  private readonly budgets:WorkflowTreeBudgetDatabase;
  constructor(private readonly backend:SchedulerBackend,private readonly scheduler:SchedulerDatabase){this.budgets=new WorkflowTreeBudgetDatabase(backend);}
  private table():string{return `${this.backend.prefix}mayura_workflow_tree_members`;}
  private owners():string{return `${this.backend.prefix}mayura_workflow_owners`;}
  private hashes(manifest:WorkflowTreeManifest,policy:WorkflowTreePolicyManifest,resources:WorkflowResourcePlan){return{
    scope:digest('mayura:scope:v1',policy.scope),definition:digest('mayura:workflow-tree:v1',manifest),
    policy:digest('mayura:workflow-tree-policy:v1',policy),resources:digest('mayura:workflow-tree-resources:v1',resources),
  };}
  async initialize():Promise<void>{
    if(this.initialized)return;await this.scheduler.execute('initialize',{});await this.budgets.execute('initialize',{});
    await this.backend.transaction(async tx=>{
      if(this.backend.dialect==='postgres')await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))',[`mayura:workflow-tree-schema:${this.backend.prefix}`]);
      await initializeOwnership(tx,this.backend);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.table()} (
        scope TEXT NOT NULL,root_id TEXT NOT NULL,aggregate_id TEXT NOT NULL,parent_id TEXT,node_id TEXT,account_id TEXT NOT NULL,
        definition_hash TEXT NOT NULL,policy_hash TEXT NOT NULL,resource_hash TEXT NOT NULL,
        PRIMARY KEY(scope,aggregate_id),UNIQUE(scope,root_id,account_id),UNIQUE(scope,parent_id,node_id),
        FOREIGN KEY(scope,aggregate_id) REFERENCES ${this.owners()}(scope,aggregate_id),
        CHECK((parent_id IS NULL AND node_id IS NULL AND aggregate_id = root_id AND account_id = 'root') OR (parent_id IS NOT NULL AND node_id IS NOT NULL AND aggregate_id <> root_id AND account_id <> 'root')))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_workflow_tree_members_root_idx ON ${this.table()}(scope,root_id,aggregate_id)`);
    });this.initialized=true;
  }
  private command(raw:WorkflowTreeRootSubmission){
    const manifest=workflowTreeManifest(raw.manifest);const policy=workflowTreePolicy(raw.policy);const resources=workflowTreeRootResources(raw.resources,manifest);
    const key=identifier(raw.idempotencyKey,'Submission key');if(key.length>128)throw new StorageError('INVALID_INPUT','Submission key exceeds its bound.');
    const input=jsonValue(raw.input,{maxBytes:policy.maxOutputBytes});const grants=new Set(policy.permissions);
    let cost=0n;let calls=0;
    for(const node of manifest.graph){
      if(node.kind==='tool'){cost+=BigInt(node.costMicros);calls++;}
      else if(node.kind==='child'){
        if(node.policy.permissions.some(grant=>!grants.has(grant))||node.policy.maxCostMicros>policy.maxCostMicros||node.policy.maxCalls>policy.maxCalls||node.policy.maxOutputBytes>policy.maxOutputBytes||node.policy.approvalTtlMs>policy.approvalTtlMs)conflict();
        const tools=node.workflow.graph.filter(item=>item.kind==='tool');cost+=tools.reduce((total,item)=>total+BigInt(item.costMicros),0n);calls+=tools.length;
      }
    }
    if(cost>BigInt(policy.maxCostMicros)||calls>policy.maxCalls)throw new StorageError('LIMIT_EXCEEDED','Root policy cannot fund every required declared tool.');
    return{manifest,policy,resources,input,key,hashes:this.hashes(manifest,policy,resources)};
  }
  private async locked(tx:SchedulerSession,scope:string,rootId:string,policyHash:string):Promise<WorkflowTreeRootSnapshot|undefined>{
    const budget=await this.budgets.inSession(tx).execute('inspect',{scope,id:rootId,policyHash}) as WorkflowTreeBudgetSnapshot|undefined;
    const row=await loadAggregate(tx,this.backend,scope,rootId);if(!row){if(budget)failed();return undefined;}if(!budget)failed();
    const owner=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,rootId]))[0];
    const member=(await tx.query<MemberRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,rootId]))[0];
    if(!owner||!member||Number(owner.profile)!==3||storedInteger(owner.aggregate_version)!==storedInteger(row.version)||member.root_id!==rootId||member.parent_id!==null||member.node_id!==null||member.account_id!=='root')failed();
    let data:RootOwner;try{data=JSON.parse(owner.data) as RootOwner;}catch{return failed();}
    const manifest=workflowTreeManifest(data.manifest);const policy=workflowTreePolicy(data.policy);const resources=workflowTreeRootResources(data.resources,manifest);const hashes=this.hashes(manifest,policy,resources);
    if(data.format!==4||data.rootId!==rootId||hashes.scope!==scope||hashes.definition!==row.definition_hash||hashes.definition!==owner.definition_hash||hashes.definition!==member.definition_hash||hashes.policy!==policyHash||hashes.policy!==owner.policy_hash||hashes.policy!==member.policy_hash||hashes.resources!==owner.resource_hash||hashes.resources!==member.resource_hash||!same(data,{format:4,rootId,manifest,policy,resources}))failed();
    const record=aggregateRecord(row);const state=workflowTreeState(record);assertWorkflowTreeRootState(state,manifest,policy,resources);
    if(state.rootId!==rootId||state.definition!==hashes.definition||state.policy!==policyHash||state.budgetVersion!==budget.version)failed();
    const account=budget.accounts.find(item=>item.id==='root');if(!account||account.maxCostMicros!==policy.maxCostMicros||account.maxCalls!==policy.maxCalls)failed();
    return{record,profile:'scheduled-v3',rootId,accountId:'root',manifestHash:hashes.definition,policyHash:hashes.policy,resourceHash:hashes.resources,budget};
  }
  private async rootOwner(tx:SchedulerSession,scope:string,rootId:string):Promise<RootOwner>{
    const row=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?`,[scope,rootId]))[0];if(!row||Number(row.profile)!==3)failed();
    try{const raw=JSON.parse(row.data) as RootOwner;if(raw.format!==4||raw.rootId!==rootId)failed();return{format:4,rootId,manifest:workflowTreeManifest(raw.manifest),policy:workflowTreePolicy(raw.policy),resources:workflowTreeRootResources(raw.resources,raw.manifest)};}catch{return failed();}
  }
  async submit(raw:WorkflowTreeRootSubmission):Promise<{readonly snapshot:WorkflowTreeRootSnapshot;readonly created:boolean}>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');const input=this.command(raw);
    const id=digest('mayura:workflow-tree-run:v1',{scope:input.hashes.scope,submissionKey:input.key});
    const state=initialWorkflowTreeRootState(input.manifest,input.input,id,input.hashes.definition,input.hashes.policy,input.policy);
    return this.backend.transaction(async tx=>{
      const ledger=this.budgets.inSession(tx);await ledger.execute('create',{scope:input.hashes.scope,id,policyHash:input.hashes.policy,maxCostMicros:input.policy.maxCostMicros,maxCalls:input.policy.maxCalls});
      await lockRunIdentity(tx,this.backend,input.hashes.scope,id);await loadAggregate(tx,this.backend,input.hashes.scope,id);
      const now=await storageClock(tx,this.backend);const created=await createAggregate(tx,this.backend,createCommand({scope:input.hashes.scope,id,idempotencyKey:input.key,definitionHash:input.hashes.definition,state:state as unknown as JsonObject,events:[{type:'run.created',data:{}},{type:'workflow.enrolled',data:{profile:'scheduled-v3'}}]}),now);
      if(!created.created){const snapshot=await this.locked(tx,input.hashes.scope,id,input.hashes.policy);if(!snapshot||snapshot.resourceHash!==input.hashes.resources)conflict();return{snapshot,created:false};}
      const data:RootOwner={format:4,rootId:id,manifest:input.manifest,policy:input.policy,resources:input.resources};
      await tx.query(`INSERT INTO ${this.owners()} (scope,aggregate_id,profile,aggregate_version,definition_hash,policy_hash,resource_hash,data) VALUES (?,?,?,?,?,?,?,?)`,[input.hashes.scope,id,3,created.row.version,input.hashes.definition,input.hashes.policy,input.hashes.resources,JSON.stringify(data)]);
      await tx.query(`INSERT INTO ${this.table()} (scope,root_id,aggregate_id,parent_id,node_id,account_id,definition_hash,policy_hash,resource_hash) VALUES (?,?,?,?,?,?,?,?,?)`,[input.hashes.scope,id,id,null,null,'root',input.hashes.definition,input.hashes.policy,input.hashes.resources]);
      const snapshot=await this.locked(tx,input.hashes.scope,id,input.hashes.policy);if(!snapshot)failed();return{snapshot,created:true};
    });
  }
  async inspect(scope:string,rootId:string,policyHash:string):Promise<WorkflowTreeRootSnapshot|undefined>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');
    return this.backend.transaction(tx=>this.locked(tx,scope,rootId,policyHash));
  }
  async admitChild(raw:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly parentId:string;readonly nodeId:string;readonly expectedVersion:number;readonly input:JsonValue}):Promise<WorkflowTreeChildAdmission>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');
    const scope=identifier(raw.scope,'Scope');const rootId=identifier(raw.rootId,'Root');const parentId=identifier(raw.parentId,'Parent');const nodeId=identifier(raw.nodeId,'Node');
    if(!/^[a-f0-9]{64}$/.test(rootId)||!/^[a-f0-9]{64}$/.test(parentId)||!/^[a-f0-9]{64}$/.test(raw.rootPolicyHash)||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)throw new StorageError('INVALID_INPUT','Child admission requires exact bounded identities.');
    if(parentId!==rootId)conflict();
    return this.backend.transaction(async tx=>{
      const root=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!root)throw new StorageError('NOT_FOUND','Workflow-tree root was not found.');
      const owner=await this.rootOwner(tx,scope,rootId);const node=owner.manifest.graph.find(item=>item.id===nodeId);if(!node||node.kind!=='child')conflict();
      const input=jsonValue(raw.input,{maxBytes:node.policy.maxOutputBytes});const inputHash=digest('mayura:workflow-tree-child-input:v1',input);
      const childId=digest('mayura:workflow-tree-child-run:v1',{scope,rootId,parentId,nodeId});const accountId=`child/${digest('mayura:workflow-tree-account:v1',{scope,rootId,parentId,nodeId})}`;
      const childPolicy=workflowTreePolicy({scope:owner.policy.scope,permissions:node.policy.permissions,policyVersion:owner.policy.policyVersion,maxCostMicros:node.policy.maxCostMicros,maxCalls:node.policy.maxCalls,maxOutputBytes:node.policy.maxOutputBytes,approvalTtlMs:node.policy.approvalTtlMs});
      const definitionHash=digest('mayura:workflow:v1',node.workflow);const policyHash=digest('mayura:workflow-tree-policy:v1',childPolicy);const resourceHash=digest('mayura:workflow-resources:v1',node.resources);
      const state=workflowTreeState(root.record);const step=state.steps[nodeId];if(!step||step.kind!=='child')failed();
      if(step.child){
        if(step.child.runId!==childId||step.child.accountId!==accountId||step.child.definitionHash!==definitionHash||step.child.policyHash!==policyHash||step.child.inputHash!==inputHash)conflict();
        const child=await loadAggregate(tx,this.backend,scope,childId);if(!child)failed();return{root,child:aggregateRecord(child),childId,accountId,definitionHash,policyHash,resourceHash,inputHash,created:false};
      }
      if(root.record.version!==raw.expectedVersion||!['running','waiting'].includes(state.status)||step.status!=='pending'||node.dependsOn.some(dependency=>state.steps[dependency]?.status!=='succeeded'))conflict();
      await lockRunIdentity(tx,this.backend,scope,childId);if(await loadAggregate(tx,this.backend,scope,childId))conflict();
      const ledger=this.budgets.inSession(tx);const budget=await ledger.execute('fork',{scope,id:rootId,policyHash:raw.rootPolicyHash,parentId:'root',accountId,maxCostMicros:childPolicy.maxCostMicros,maxCalls:childPolicy.maxCalls}) as WorkflowTreeBudgetSnapshot;
      const childState=initialWorkflowTreeLeafState(node.workflow,input,rootId,accountId,definitionHash,policyHash,childPolicy);
      const mutable=structuredClone(childState) as unknown as {accountId:string;budgetVersion:number};mutable.accountId=accountId;mutable.budgetVersion=budget.version;
      const now=await storageClock(tx,this.backend);const created=await createAggregate(tx,this.backend,createCommand({scope,id:childId,idempotencyKey:digest('mayura:workflow-tree-child-submission:v1',{scope,rootId,parentId,nodeId}),definitionHash,state:mutable as unknown as JsonObject,events:[{type:'run.created',data:{}},{type:'workflow.enrolled',data:{profile:'scheduled-v3',rootId,parentId,nodeId}}]}),now);if(!created.created)conflict();
      const childOwner:ChildOwner={format:4,rootId,parentId,nodeId,accountId,manifest:node.workflow,policy:childPolicy,resources:node.resources,inputHash};
      await tx.query(`INSERT INTO ${this.owners()} (scope,aggregate_id,profile,aggregate_version,definition_hash,policy_hash,resource_hash,data) VALUES (?,?,?,?,?,?,?,?)`,[scope,childId,3,created.row.version,definitionHash,policyHash,resourceHash,JSON.stringify(childOwner)]);
      await tx.query(`INSERT INTO ${this.table()} (scope,root_id,aggregate_id,parent_id,node_id,account_id,definition_hash,policy_hash,resource_hash) VALUES (?,?,?,?,?,?,?,?,?)`,[scope,rootId,childId,parentId,nodeId,accountId,definitionHash,policyHash,resourceHash]);
      const rootState=structuredClone(state);const rootStep=rootState.steps[nodeId]!;rootStep.status='waiting';rootStep.candidateHash=inputHash;rootStep.child={runId:childId,accountId,definitionHash,policyHash,inputHash,joinedVersion:null};rootState.budgetVersion=budget.version;rootState.status='waiting';
      const rootRow=await loadAggregate(tx,this.backend,scope,rootId);if(!rootRow)failed();const updated=await writeAggregate(tx,this.backend,rootRow,rootState as unknown as JsonObject,[{type:'workflow.child_admitted',data:{nodeId,childId}}],now);
      await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updated.version,scope,rootId]);
      const current=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!current)failed();return{root:current,child:aggregateRecord(created.row),childId,accountId,definitionHash,policyHash,resourceHash,inputHash,created:true};
    });
  }
}
