import { createHash } from 'node:crypto';
import { jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import {
  StorageError, assertWorkflowTreeLeafState, assertWorkflowTreeRootState, initialWorkflowTreeLeafState, initialWorkflowTreeRootState, mergeWorkflowReceipt, workflowHashMaterial,
  workflowManifest, workflowResources, workflowTreeManifest, workflowTreePolicy, workflowTreeRootResources, workflowTreeState,
  type Claim, type EvidenceDisposition, type JobRecord, type StoredEventInput, type StoredRecord, type WorkflowManifest, type WorkflowResourcePlan, type WorkflowTreeManifest, type WorkflowTreePolicyManifest,
} from '@mayura/storage-contracts';
import type { ExecutionReceipt } from '@mayura/core';
import {
  aggregateRecord, createAggregate, initializeOwnership, loadAggregate, lockRunIdentity, lockSql, storageClock, storedInteger, writeAggregate,
} from './aggregate-session.js';
import { WorkflowTreeBudgetDatabase } from './durable-budget-database.js';
import type { WorkflowTreeBudgetSnapshot } from './durable-budget-state.js';
import { createCommand, identifier } from './validation.js';
import { SchedulerDatabase, type SchedulerBackend, type SchedulerSession } from './scheduler-database.js';

interface OwnerRow { scope:string;aggregate_id:string;profile:number|string;aggregate_version:number|string;definition_hash:string;policy_hash:string;resource_hash:string;data:string }
interface MemberRow { scope:string;root_id:string;aggregate_id:string;parent_id:string|null;node_id:string|null;account_id:string;definition_hash:string;policy_hash:string;resource_hash:string }
interface TreeJobRow { scope:string;root_id:string;aggregate_id:string;node_id:string;job_id:string;account_id:string;reservation_id:string;cost_micros:number|string }
interface RootOwner { format:4;rootId:string;manifest:WorkflowTreeManifest;policy:WorkflowTreePolicyManifest;resources:WorkflowResourcePlan }
interface ChildOwner { format:4;rootId:string;parentId:string;nodeId:string;accountId:string;manifest:WorkflowManifest;policy:WorkflowTreePolicyManifest;resources:WorkflowResourcePlan;inputHash:string }
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
export interface WorkflowTreePreparedTool { readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord;readonly created:boolean }
export interface WorkflowTreeClaimedTool { readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord;readonly claim:Claim }
export interface WorkflowTreeStartedTool { readonly status:'started'|'already_started';readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord }
export interface WorkflowTreeReceiptResult { readonly disposition:EvidenceDisposition;readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord }
export interface WorkflowTreeCompletedTool { readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord }
export interface WorkflowTreeMemberResult { readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord }
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
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.backend.prefix}mayura_workflow_tree_jobs (
        scope TEXT NOT NULL,root_id TEXT NOT NULL,aggregate_id TEXT NOT NULL,node_id TEXT NOT NULL,job_id TEXT NOT NULL,
        account_id TEXT NOT NULL,reservation_id TEXT NOT NULL,cost_micros BIGINT NOT NULL CHECK(cost_micros >= 0),
        PRIMARY KEY(scope,aggregate_id,node_id),UNIQUE(scope,job_id),UNIQUE(scope,root_id,reservation_id),
        FOREIGN KEY(scope,aggregate_id) REFERENCES ${this.table()}(scope,aggregate_id),
        FOREIGN KEY(scope,job_id) REFERENCES ${this.backend.prefix}mayura_scheduler_jobs(scope,job_id))`);
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
  private async childRecord(tx:SchedulerSession,scope:string,rootId:string,parentId:string,nodeId:string,childId:string,accountId:string,definitionHash:string,policyHash:string,resourceHash:string,inputHash:string,budget:WorkflowTreeBudgetSnapshot):Promise<StoredRecord>{
    const row=await loadAggregate(tx,this.backend,scope,childId);const member=(await tx.query<MemberRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,childId]))[0];const owner=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,childId]))[0];
    if(!row||!member||!owner||Number(owner.profile)!==3||storedInteger(owner.aggregate_version)!==storedInteger(row.version)||member.root_id!==rootId||member.parent_id!==parentId||member.node_id!==nodeId||member.account_id!==accountId||member.definition_hash!==definitionHash||member.policy_hash!==policyHash||member.resource_hash!==resourceHash||owner.definition_hash!==definitionHash||owner.policy_hash!==policyHash||owner.resource_hash!==resourceHash)failed();
    let data:ChildOwner;try{const raw=JSON.parse(owner.data) as ChildOwner;const manifest=workflowManifest(raw.manifest);const policy=workflowTreePolicy(raw.policy);const resources=workflowResources(raw.resources,manifest);data={format:raw.format,rootId:raw.rootId,parentId:raw.parentId,nodeId:raw.nodeId,accountId:raw.accountId,manifest,policy,resources,inputHash:raw.inputHash};}catch{return failed();}
    if(data.format!==4||data.rootId!==rootId||data.parentId!==parentId||data.nodeId!==nodeId||data.accountId!==accountId||data.inputHash!==inputHash||digest('mayura:workflow:v1',data.manifest)!==definitionHash||digest('mayura:workflow-tree-policy:v1',data.policy)!==policyHash||digest('mayura:workflow-resources:v1',data.resources)!==resourceHash)failed();
    const record=aggregateRecord(row);const state=workflowTreeState(record);assertWorkflowTreeLeafState(state,data.manifest,data.policy,data.resources);
    if(state.rootId!==rootId||state.accountId!==accountId||state.definition!==definitionHash||state.policy!==policyHash||digest('mayura:workflow-tree-child-input:v1',state.input)!==inputHash||state.budgetVersion>budget.version)failed();
    const account=budget.accounts.find(item=>item.id===accountId);if(!account||account.parentId!=='root'||account.maxCostMicros!==data.policy.maxCostMicros||account.maxCalls!==data.policy.maxCalls)failed();return record;
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
        const child=await this.childRecord(tx,scope,rootId,parentId,nodeId,childId,accountId,definitionHash,policyHash,resourceHash,inputHash,root.budget);return{root,child,childId,accountId,definitionHash,policyHash,resourceHash,inputHash,created:false};
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
  async prepareChildTool(raw:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly expectedVersion:number;readonly input:JsonValue}):Promise<WorkflowTreePreparedTool>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');
    const scope=identifier(raw.scope,'Scope');const rootId=identifier(raw.rootId,'Root');const childId=identifier(raw.childId,'Child');const nodeId=identifier(raw.nodeId,'Node');
    if(![rootId,childId,raw.rootPolicyHash,raw.childPolicyHash].every(value=>/^[a-f0-9]{64}$/.test(value))||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)throw new StorageError('INVALID_INPUT','Tool preparation requires exact bounded identities.');
    return this.backend.transaction(async tx=>{
      const root=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!root)throw new StorageError('NOT_FOUND','Workflow-tree root was not found.');
      const member=(await tx.query<MemberRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,childId]))[0];if(!member||member.root_id!==rootId||!member.parent_id||!member.node_id||member.policy_hash!==raw.childPolicyHash)conflict();
      const child=await this.childRecord(tx,scope,rootId,member.parent_id,member.node_id,childId,member.account_id,member.definition_hash,member.policy_hash,member.resource_hash,digest('mayura:workflow-tree-child-input:v1',workflowTreeState(aggregateRecord((await loadAggregate(tx,this.backend,scope,childId))!)).input),root.budget);
      const ownerRow=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?`,[scope,childId]))[0];if(!ownerRow)failed();let owner:ChildOwner;try{owner=JSON.parse(ownerRow.data) as ChildOwner;owner={...owner,manifest:workflowManifest(owner.manifest),policy:workflowTreePolicy(owner.policy),resources:workflowResources(owner.resources,owner.manifest)};}catch{return failed();}
      const state=workflowTreeState(child);const node=owner.manifest.graph.find(item=>item.id===nodeId);const step=state.steps[nodeId];if(!node||node.kind!=='tool'||!step||step.kind!=='tool')conflict();
      const input=jsonValue(raw.input,{maxBytes:owner.policy.maxOutputBytes});const candidateHash=digest('mayura:workflow-tree-candidate:v1',{rootId,memberId:childId,nodeId,input,policyHash:raw.childPolicyHash});
      const jobId=digest('mayura:workflow-tree-job:v1',{scope,rootId,memberId:childId,nodeId});const reservationId=digest('mayura:workflow-tree-ticket:v1',{scope,rootId,memberId:childId,nodeId});
      if(step.candidateHash!==null){
        if(step.candidateHash!==candidateHash)conflict();const job=await this.scheduler.inSession(tx,childId,[]).execute('read',{scope,jobId}) as JobRecord|undefined;if(!job)failed();return{root,member:child,job,created:false};
      }
      const required=[`tool:${node.tool}`,...node.capabilities,...(node.effects==='none'?[]:[`effect:${node.effects}`])];if(required.some(grant=>!owner.policy.permissions.includes(grant))||node.approval||child.version!==raw.expectedVersion||!['running','waiting'].includes(state.status)||step.status!=='pending'||node.dependsOn.some(dependency=>state.steps[dependency]?.status!=='succeeded'))conflict();
      const budget=await this.budgets.inSession(tx).execute('reserveBundle',{scope,id:rootId,policyHash:raw.rootPolicyHash,accountId:member.account_id,bundleId:jobId,operations:[{id:reservationId,maxCostMicros:node.costMicros}]}) as WorkflowTreeBudgetSnapshot;
      const events:StoredEventInput[]=[];const job=(await this.scheduler.inSession(tx,childId,events).execute('reserve',{scope,jobId,reservationKey:jobId,runId:childId,nodeId,invocationId:`${childId}/step:${nodeId}`,definitionHash:member.definition_hash,candidateHash,intent:{toolId:node.tool,callId:`${childId}/step:${nodeId}`,policyHash:raw.childPolicyHash,reservationId},resourceKeys:owner.resources[nodeId]!,delayMs:0}) as {job:JobRecord}).job;
      await tx.query(`INSERT INTO ${this.backend.prefix}mayura_workflow_tree_jobs (scope,root_id,aggregate_id,node_id,job_id,account_id,reservation_id,cost_micros) VALUES (?,?,?,?,?,?,?,?)`,[scope,rootId,childId,nodeId,jobId,member.account_id,reservationId,node.costMicros]);
      const childState=structuredClone(state);childState.steps[nodeId]!.candidateHash=candidateHash;childState.steps[nodeId]!.costReserved=node.costMicros;childState.reservedMicros+=node.costMicros;childState.budgetVersion=budget.version;
      const childRow=await loadAggregate(tx,this.backend,scope,childId);if(!childRow)failed();const updatedChild=await writeAggregate(tx,this.backend,childRow,childState as unknown as JsonObject,[...events,{type:'step.prepared',data:{nodeId}}],await storageClock(tx,this.backend));await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updatedChild.version,scope,childId]);
      const rootState=workflowTreeState(root.record);const mutableRoot=structuredClone(rootState);mutableRoot.budgetVersion=budget.version;const rootRow=await loadAggregate(tx,this.backend,scope,rootId);if(!rootRow)failed();const updatedRoot=await writeAggregate(tx,this.backend,rootRow,mutableRoot as unknown as JsonObject,[{type:'workflow.budget_updated',data:{memberId:childId,nodeId}}],await storageClock(tx,this.backend));await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updatedRoot.version,scope,rootId]);
      const current=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!current)failed();return{root:current,member:aggregateRecord(updatedChild),job,created:true};
    });
  }
  async claimPreparedChildTool(raw:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly workerId:string;readonly leaseMs:number}):Promise<WorkflowTreeClaimedTool|undefined>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');
    const scope=identifier(raw.scope,'Scope');const rootId=identifier(raw.rootId,'Root');const childId=identifier(raw.childId,'Child');const nodeId=identifier(raw.nodeId,'Node');const workerId=identifier(raw.workerId,'Worker');
    if(![rootId,childId,raw.rootPolicyHash,raw.childPolicyHash].every(value=>/^[a-f0-9]{64}$/.test(value))||!Number.isSafeInteger(raw.leaseMs)||raw.leaseMs<1_000||raw.leaseMs>300_000)throw new StorageError('INVALID_INPUT','Child claim requires exact bounded identities and lease.');
    return this.backend.transaction(async tx=>{
      const root=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!root)throw new StorageError('NOT_FOUND','Workflow-tree root was not found.');
      const member=(await tx.query<MemberRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,childId]))[0];const ownerRow=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?`,[scope,childId]))[0];if(!member||!member.parent_id||!member.node_id||member.root_id!==rootId||member.policy_hash!==raw.childPolicyHash||!ownerRow)conflict();
      let owner:ChildOwner;try{owner=JSON.parse(ownerRow.data) as ChildOwner;}catch{return failed();}
      const child=await this.childRecord(tx,scope,rootId,member.parent_id,member.node_id,childId,member.account_id,member.definition_hash,member.policy_hash,member.resource_hash,owner.inputHash,root.budget);const state=workflowTreeState(child);const step=state.steps[nodeId];if(!step||step.kind!=='tool'||step.candidateHash===null)conflict();
      const link=(await tx.query<TreeJobRow>(`SELECT * FROM ${this.backend.prefix}mayura_workflow_tree_jobs WHERE scope = ? AND aggregate_id = ? AND node_id = ?${lockSql(this.backend)}`,[scope,childId,nodeId]))[0];if(!link||link.root_id!==rootId||link.account_id!==member.account_id)failed();
      const events:StoredEventInput[]=[];const claims=await this.scheduler.inSession(tx,childId,events,link.job_id).execute('claim',{scope,workerId,limit:1,leaseMs:raw.leaseMs}) as {job:JobRecord;claim:Claim}[];const claimed=claims[0];if(!claimed)return undefined;
      const row=await loadAggregate(tx,this.backend,scope,childId);if(!row)failed();const updated=await writeAggregate(tx,this.backend,row,state as unknown as JsonObject,events,await storageClock(tx,this.backend));await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updated.version,scope,childId]);return{root,member:aggregateRecord(updated),job:claimed.job,claim:claimed.claim};
    });
  }
  async startClaimedChildTool(raw:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly expectedVersion:number;readonly claim:Claim;readonly input:JsonValue}):Promise<WorkflowTreeStartedTool>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');
    const scope=identifier(raw.scope,'Scope');const rootId=identifier(raw.rootId,'Root');const childId=identifier(raw.childId,'Child');const nodeId=identifier(raw.nodeId,'Node');
    if(![rootId,childId,raw.rootPolicyHash,raw.childPolicyHash].every(value=>/^[a-f0-9]{64}$/.test(value))||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)throw new StorageError('INVALID_INPUT','Child start requires exact bounded identities.');
    return this.backend.transaction(async tx=>{
      const root=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!root)throw new StorageError('NOT_FOUND','Workflow-tree root was not found.');
      const member=(await tx.query<MemberRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,childId]))[0];const ownerRow=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?`,[scope,childId]))[0];if(!member||!member.parent_id||!member.node_id||member.root_id!==rootId||member.policy_hash!==raw.childPolicyHash||!ownerRow)conflict();
      let owner:ChildOwner;try{owner=JSON.parse(ownerRow.data) as ChildOwner;owner={...owner,manifest:workflowManifest(owner.manifest),policy:workflowTreePolicy(owner.policy),resources:workflowResources(owner.resources,owner.manifest)};}catch{return failed();}
      const child=await this.childRecord(tx,scope,rootId,member.parent_id,member.node_id,childId,member.account_id,member.definition_hash,member.policy_hash,member.resource_hash,owner.inputHash,root.budget);const state=workflowTreeState(child);const node=owner.manifest.graph.find(item=>item.id===nodeId);const step=state.steps[nodeId];if(!node||node.kind!=='tool'||!step||step.kind!=='tool'||step.candidateHash===null||(child.version!==raw.expectedVersion&&step.status!=='dispatching'))conflict();
      const input=jsonValue(raw.input,{maxBytes:owner.policy.maxOutputBytes});const candidateHash=digest('mayura:workflow-tree-candidate:v1',{rootId,memberId:childId,nodeId,input,policyHash:raw.childPolicyHash});if(candidateHash!==step.candidateHash)conflict();
      const link=(await tx.query<TreeJobRow>(`SELECT * FROM ${this.backend.prefix}mayura_workflow_tree_jobs WHERE scope = ? AND aggregate_id = ? AND node_id = ?${lockSql(this.backend)}`,[scope,childId,nodeId]))[0];if(!link||link.root_id!==rootId||link.account_id!==member.account_id||storedInteger(link.cost_micros)!==node.costMicros)failed();
      const budgetResult=await this.budgets.inSession(tx).execute('start',{scope,id:rootId,policyHash:raw.rootPolicyHash,accountId:member.account_id,reservationId:link.reservation_id}) as {snapshot:WorkflowTreeBudgetSnapshot;status:'started'|'already_started'};
      const events:StoredEventInput[]=[];const schedulerResult=await this.scheduler.inSession(tx,childId,events,link.job_id).execute('start',{claim:raw.claim,candidateHash}) as {status:'started'|'already_started';job:JobRecord};if(schedulerResult.status!==budgetResult.status)failed();
      if(schedulerResult.status==='already_started')return{status:'already_started',root,member:child,job:schedulerResult.job};
      const childState=structuredClone(state);childState.steps[nodeId]!.status='dispatching';childState.status='running';childState.budgetVersion=budgetResult.snapshot.version;const now=await storageClock(tx,this.backend);const childRow=await loadAggregate(tx,this.backend,scope,childId);if(!childRow)failed();const updatedChild=await writeAggregate(tx,this.backend,childRow,childState as unknown as JsonObject,[...events,{type:'step.dispatching',data:{nodeId}}],now);await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updatedChild.version,scope,childId]);
      const rootState=workflowTreeState(root.record);const mutableRoot=structuredClone(rootState);mutableRoot.budgetVersion=budgetResult.snapshot.version;const rootRow=await loadAggregate(tx,this.backend,scope,rootId);if(!rootRow)failed();const updatedRoot=await writeAggregate(tx,this.backend,rootRow,mutableRoot as unknown as JsonObject,[{type:'workflow.budget_updated',data:{memberId:childId,nodeId}}],now);await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updatedRoot.version,scope,rootId]);
      const current=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!current)failed();return{status:'started',root:current,member:aggregateRecord(updatedChild),job:schedulerResult.job};
    });
  }
  async recordChildToolReceipt(raw:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly fence:number;readonly evidenceId:string;readonly receipt:ExecutionReceipt}):Promise<WorkflowTreeReceiptResult>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');
    const scope=identifier(raw.scope,'Scope');const rootId=identifier(raw.rootId,'Root');const childId=identifier(raw.childId,'Child');const nodeId=identifier(raw.nodeId,'Node');const evidenceId=identifier(raw.evidenceId,'Evidence');
    if(![rootId,childId,raw.rootPolicyHash,raw.childPolicyHash].every(value=>/^[a-f0-9]{64}$/.test(value))||!Number.isSafeInteger(raw.fence)||raw.fence<1)throw new StorageError('INVALID_INPUT','Receipt persistence requires exact bounded identities.');
    return this.backend.transaction(async tx=>{
      const root=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!root)throw new StorageError('NOT_FOUND','Workflow-tree root was not found.');
      const member=(await tx.query<MemberRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,childId]))[0];const ownerRow=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?`,[scope,childId]))[0];if(!member||!member.parent_id||!member.node_id||member.root_id!==rootId||member.policy_hash!==raw.childPolicyHash||!ownerRow)conflict();
      let owner:ChildOwner;try{owner=JSON.parse(ownerRow.data) as ChildOwner;owner={...owner,manifest:workflowManifest(owner.manifest),policy:workflowTreePolicy(owner.policy),resources:workflowResources(owner.resources,owner.manifest)};}catch{return failed();}
      const child=await this.childRecord(tx,scope,rootId,member.parent_id,member.node_id,childId,member.account_id,member.definition_hash,member.policy_hash,member.resource_hash,owner.inputHash,root.budget);const state=workflowTreeState(child);const node=owner.manifest.graph.find(item=>item.id===nodeId);const step=state.steps[nodeId];if(!node||node.kind!=='tool'||!step||step.kind!=='tool'||!['dispatching','unknown'].includes(step.status))conflict();
      const link=(await tx.query<TreeJobRow>(`SELECT * FROM ${this.backend.prefix}mayura_workflow_tree_jobs WHERE scope = ? AND aggregate_id = ? AND node_id = ?${lockSql(this.backend)}`,[scope,childId,nodeId]))[0];if(!link||link.root_id!==rootId||link.account_id!==member.account_id||storedInteger(link.cost_micros)!==node.costMicros)failed();
      const events:StoredEventInput[]=[];const recorded=await this.scheduler.inSession(tx,childId,events,link.job_id).execute('recordReceipt',{scope,jobId:link.job_id,fence:raw.fence,evidenceId,receipt:raw.receipt}) as {disposition:EvidenceDisposition;job:JobRecord};
      if(recorded.disposition==='conflicting')return{disposition:recorded.disposition,root,member:child,job:recorded.job};
      const prior=step.receipt===null?null:step.receipt as unknown as ExecutionReceipt;const receipt=mergeWorkflowReceipt(prior,raw.receipt);let budget=root.budget;
      if(receipt.execution==='unknown')budget=await this.budgets.inSession(tx).execute('markUnknown',{scope,id:rootId,policyHash:raw.rootPolicyHash,accountId:member.account_id,reservationId:link.reservation_id}) as WorkflowTreeBudgetSnapshot;
      else budget=(await this.budgets.inSession(tx).execute('settle',{scope,id:rootId,policyHash:raw.rootPolicyHash,accountId:member.account_id,reservationId:link.reservation_id,actualMicros:receipt.execution==='not_started'?0:node.costMicros}) as {snapshot:WorkflowTreeBudgetSnapshot}).snapshot;
      if(same(prior,receipt)&&budget.version===root.budget.version&&events.length===0)return{disposition:recorded.disposition,root,member:child,job:recorded.job};
      const childState=structuredClone(state);const childStep=childState.steps[nodeId]!;childStep.receipt=receipt as unknown as JsonValue;if(receipt.execution==='unknown'){childStep.status='unknown';childState.status='outcome_unknown';}else if(childStep.costReserved!==0){childState.reservedMicros-=childStep.costReserved;if(receipt.execution!=='not_started')childState.spentMicros+=node.costMicros;childStep.costReserved=0;}if(childState.status==='outcome_unknown'&&childState.reservedMicros===0)budget=await this.budgets.inSession(tx).execute('closeSubtree',{scope,id:rootId,policyHash:raw.rootPolicyHash,accountId:member.account_id}) as WorkflowTreeBudgetSnapshot;childState.budgetVersion=budget.version;
      const now=await storageClock(tx,this.backend);const childRow=await loadAggregate(tx,this.backend,scope,childId);if(!childRow)failed();const updatedChild=await writeAggregate(tx,this.backend,childRow,childState as unknown as JsonObject,events,now);await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updatedChild.version,scope,childId]);
      const rootState=workflowTreeState(root.record);const mutableRoot=structuredClone(rootState);mutableRoot.budgetVersion=budget.version;const rootRow=await loadAggregate(tx,this.backend,scope,rootId);if(!rootRow)failed();const updatedRoot=await writeAggregate(tx,this.backend,rootRow,mutableRoot as unknown as JsonObject,[{type:'workflow.budget_updated',data:{memberId:childId,nodeId}}],now);await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updatedRoot.version,scope,rootId]);
      const current=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!current)failed();return{disposition:recorded.disposition,root:current,member:aggregateRecord(updatedChild),job:recorded.job};
    });
  }
  async completeChildTool(raw:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly claim:Claim;readonly commandId:string;readonly evidenceId:string;readonly outcome:'succeeded'|'failed'|'blocked';readonly output:JsonValue|null}):Promise<WorkflowTreeCompletedTool>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');
    const scope=identifier(raw.scope,'Scope');const rootId=identifier(raw.rootId,'Root');const childId=identifier(raw.childId,'Child');const nodeId=identifier(raw.nodeId,'Node');const commandId=identifier(raw.commandId,'Command');const evidenceId=identifier(raw.evidenceId,'Evidence');
    if(![rootId,childId,raw.rootPolicyHash,raw.childPolicyHash].every(value=>/^[a-f0-9]{64}$/.test(value))||(raw.outcome!=='succeeded'&&raw.output!==null))throw new StorageError('INVALID_INPUT','Completion requires exact bounded identities and output semantics.');
    return this.backend.transaction(async tx=>{
      const root=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!root)throw new StorageError('NOT_FOUND','Workflow-tree root was not found.');const member=(await tx.query<MemberRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,childId]))[0];const ownerRow=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?`,[scope,childId]))[0];if(!member||!member.parent_id||!member.node_id||member.root_id!==rootId||member.policy_hash!==raw.childPolicyHash||!ownerRow)conflict();
      let owner:ChildOwner;try{owner=JSON.parse(ownerRow.data) as ChildOwner;owner={...owner,manifest:workflowManifest(owner.manifest),policy:workflowTreePolicy(owner.policy),resources:workflowResources(owner.resources,owner.manifest)};}catch{return failed();}const child=await this.childRecord(tx,scope,rootId,member.parent_id,member.node_id,childId,member.account_id,member.definition_hash,member.policy_hash,member.resource_hash,owner.inputHash,root.budget);const state=workflowTreeState(child);if(state.status==='outcome_unknown')conflict();const node=owner.manifest.graph.find(item=>item.id===nodeId);const step=state.steps[nodeId];if(!node||node.kind!=='tool'||!step||step.kind!=='tool'||!['dispatching',raw.outcome].includes(step.status)||step.costReserved!==0)conflict();
      const output=raw.outcome==='succeeded'?jsonValue(raw.output,{maxBytes:owner.policy.maxOutputBytes}):null;const link=(await tx.query<TreeJobRow>(`SELECT * FROM ${this.backend.prefix}mayura_workflow_tree_jobs WHERE scope = ? AND aggregate_id = ? AND node_id = ?${lockSql(this.backend)}`,[scope,childId,nodeId]))[0];if(!link)failed();const events:StoredEventInput[]=[];const job=await this.scheduler.inSession(tx,childId,events,link.job_id).execute('complete',{claim:raw.claim,commandId,evidenceId,outcome:raw.outcome,output}) as JobRecord;
      if(step.status===raw.outcome){if(!same(step.output,job.output)||!same(step.receipt,job.receipt))failed();return{root,member:child,job};}
      const childState=structuredClone(state);const target=childState.steps[nodeId]!;target.status=raw.outcome;target.output=job.output;if(!job.receipt)failed();target.receipt=job.receipt as unknown as JsonValue;
      let changed=true;while(changed){changed=false;for(const join of owner.manifest.graph)if(join.kind==='join'){const current=childState.steps[join.id]!;if(current.status==='pending'&&join.dependsOn.every(id=>childState.steps[id]?.status==='succeeded')){current.status='succeeded';current.output=join.dependsOn.map(id=>childState.steps[id]!.output);changed=true;}}}
      if(Object.values(childState.steps).some(item=>['failed','blocked','unknown'].includes(item.status)))childState.status=Object.values(childState.steps).some(item=>item.status==='unknown')?'outcome_unknown':Object.values(childState.steps).some(item=>item.status==='blocked')?'blocked':'failed';
      let budget=root.budget;if(childState.status!=='running'&&childState.status!=='waiting'&&childState.reservedMicros===0)budget=await this.budgets.inSession(tx).execute('closeSubtree',{scope,id:rootId,policyHash:raw.rootPolicyHash,accountId:member.account_id}) as WorkflowTreeBudgetSnapshot;childState.budgetVersion=budget.version;
      const now=await storageClock(tx,this.backend);const row=await loadAggregate(tx,this.backend,scope,childId);if(!row)failed();const updated=await writeAggregate(tx,this.backend,row,childState as unknown as JsonObject,[...events,{type:'step.completed',data:{nodeId,outcome:raw.outcome}}],now);await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updated.version,scope,childId]);if(budget.version===root.budget.version)return{root,member:aggregateRecord(updated),job};const rootState=workflowTreeState(root.record);const mutableRoot=structuredClone(rootState);mutableRoot.budgetVersion=budget.version;const rootRow=await loadAggregate(tx,this.backend,scope,rootId);if(!rootRow)failed();const updatedRoot=await writeAggregate(tx,this.backend,rootRow,mutableRoot as unknown as JsonObject,[{type:'workflow.budget_updated',data:{memberId:childId,nodeId}}],now);await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updatedRoot.version,scope,rootId]);const current=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!current)failed();return{root:current,member:aggregateRecord(updated),job};
    });
  }
  async finalizeChild(raw:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly expectedVersion:number;readonly output:JsonValue}):Promise<WorkflowTreeMemberResult>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');const scope=identifier(raw.scope,'Scope');const rootId=identifier(raw.rootId,'Root');const childId=identifier(raw.childId,'Child');if(![rootId,childId,raw.rootPolicyHash,raw.childPolicyHash].every(value=>/^[a-f0-9]{64}$/.test(value))||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)throw new StorageError('INVALID_INPUT','Child finalization requires exact bounded identities.');
    return this.backend.transaction(async tx=>{const root=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!root)throw new StorageError('NOT_FOUND','Workflow-tree root was not found.');const member=(await tx.query<MemberRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,childId]))[0];const ownerRow=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?`,[scope,childId]))[0];if(!member||!member.parent_id||!member.node_id||member.root_id!==rootId||member.policy_hash!==raw.childPolicyHash||!ownerRow)conflict();let owner:ChildOwner;try{owner=JSON.parse(ownerRow.data) as ChildOwner;owner={...owner,manifest:workflowManifest(owner.manifest),policy:workflowTreePolicy(owner.policy),resources:workflowResources(owner.resources,owner.manifest)};}catch{return failed();}const child=await this.childRecord(tx,scope,rootId,member.parent_id,member.node_id,childId,member.account_id,member.definition_hash,member.policy_hash,member.resource_hash,owner.inputHash,root.budget);const state=workflowTreeState(child);const output=jsonValue(raw.output,{maxBytes:owner.policy.maxOutputBytes});if(state.status==='succeeded'){if(!same(state.output,output))conflict();return{root,member:child};}if(child.version!==raw.expectedVersion||state.reservedMicros!==0||Object.values(state.steps).some(step=>step.status!=='succeeded'))conflict();const budget=await this.budgets.inSession(tx).execute('closeSubtree',{scope,id:rootId,policyHash:raw.rootPolicyHash,accountId:member.account_id}) as WorkflowTreeBudgetSnapshot;const childState=structuredClone(state);childState.status='succeeded';childState.output=output;childState.budgetVersion=budget.version;const now=await storageClock(tx,this.backend);const row=await loadAggregate(tx,this.backend,scope,childId);if(!row)failed();const updatedChild=await writeAggregate(tx,this.backend,row,childState as unknown as JsonObject,[{type:'run.completed',data:{status:'succeeded'}}],now);await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updatedChild.version,scope,childId]);const rootState=workflowTreeState(root.record);const mutableRoot=structuredClone(rootState);mutableRoot.budgetVersion=budget.version;const rootRow=await loadAggregate(tx,this.backend,scope,rootId);if(!rootRow)failed();const updatedRoot=await writeAggregate(tx,this.backend,rootRow,mutableRoot as unknown as JsonObject,[{type:'workflow.budget_updated',data:{memberId:childId}}],now);await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updatedRoot.version,scope,rootId]);const current=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!current)failed();return{root:current,member:aggregateRecord(updatedChild)};});
  }
  async joinChild(raw:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly nodeId:string;readonly expectedVersion:number}):Promise<WorkflowTreeRootSnapshot>{
    if(!this.initialized)throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow-tree storage first.');const scope=identifier(raw.scope,'Scope');const rootId=identifier(raw.rootId,'Root');const nodeId=identifier(raw.nodeId,'Node');if(!/^[a-f0-9]{64}$/.test(rootId)||!/^[a-f0-9]{64}$/.test(raw.rootPolicyHash)||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)throw new StorageError('INVALID_INPUT','Child join requires exact bounded identities.');
    return this.backend.transaction(async tx=>{const root=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!root)throw new StorageError('NOT_FOUND','Workflow-tree root was not found.');const owner=await this.rootOwner(tx,scope,rootId);const rootState=workflowTreeState(root.record);const step=rootState.steps[nodeId];const node=owner.manifest.graph.find(item=>item.id===nodeId);if(!step||step.kind!=='child'||!node||node.kind!=='child'||!step.child)conflict();if(step.child.joinedVersion!==null)return root;if(root.record.version!==raw.expectedVersion)conflict();const member=(await tx.query<MemberRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND aggregate_id = ?${lockSql(this.backend)}`,[scope,step.child.runId]))[0];if(!member||member.root_id!==rootId||member.parent_id!==rootId||member.node_id!==nodeId||member.account_id!==step.child.accountId||member.policy_hash!==step.child.policyHash||member.definition_hash!==step.child.definitionHash)failed();const ownerRow=(await tx.query<OwnerRow>(`SELECT * FROM ${this.owners()} WHERE scope = ? AND aggregate_id = ?`,[scope,step.child.runId]))[0];if(!ownerRow)failed();try{const childOwner=JSON.parse(ownerRow.data) as ChildOwner;workflowManifest(childOwner.manifest);workflowTreePolicy(childOwner.policy);workflowResources(childOwner.resources,childOwner.manifest);}catch{return failed();}const child=await this.childRecord(tx,scope,rootId,rootId,nodeId,step.child.runId,step.child.accountId,step.child.definitionHash,step.child.policyHash,member.resource_hash,step.child.inputHash,root.budget);const childState=workflowTreeState(child);if(!['succeeded','failed','blocked','cancelled','outcome_unknown'].includes(childState.status))conflict();const mutable=structuredClone(rootState);const target=mutable.steps[nodeId]!;target.child={...target.child!,joinedVersion:child.version};if(childState.status==='succeeded'){target.status='succeeded';target.output=childState.output;}else{target.status=childState.status==='outcome_unknown'?'unknown':childState.status==='blocked'?'blocked':'failed';mutable.status=target.status==='unknown'?'outcome_unknown':target.status==='blocked'?'blocked':'failed';}
      let changed=true;while(changed){changed=false;for(const join of owner.manifest.graph)if(join.kind==='join'){const current=mutable.steps[join.id]!;if(current.status==='pending'&&join.dependsOn.every(id=>mutable.steps[id]?.status==='succeeded')){current.status='succeeded';current.output=join.dependsOn.map(id=>mutable.steps[id]!.output);changed=true;}}}if(mutable.status==='waiting')mutable.status='running';const row=await loadAggregate(tx,this.backend,scope,rootId);if(!row)failed();const updated=await writeAggregate(tx,this.backend,row,mutable as unknown as JsonObject,[{type:'workflow.child_joined',data:{nodeId,childId:child.id,status:childState.status}}],await storageClock(tx,this.backend));await tx.query(`UPDATE ${this.owners()} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[updated.version,scope,rootId]);const current=await this.locked(tx,scope,rootId,raw.rootPolicyHash);if(!current)failed();return current;});
  }
}
