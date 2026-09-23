import { createHash } from 'node:crypto';
import { jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import {
  StorageError, workflowHashMaterial, workflowTreeBudgetSnapshot, workflowTreeManifest, workflowTreePolicy, workflowTreeRootResources, workflowTreeState,
  type JobRecord, type StoredRecord, type WorkflowTreeMethod, type WorkflowTreeStore,
} from '@mayura/storage-contracts';
import { claim, fields, hash, immutable, integer, invalid, object, receipt } from './scheduler-validation.js';
import { identifier } from './validation.js';

function value(raw:JsonObject,key:string):void{try{raw[key]=jsonValue(raw[key],{maxBytes:65_536});}catch{invalid();}}
function root(raw:JsonObject):void{hash(raw['scope']);hash(raw['rootId']);hash(raw['rootPolicyHash']);}
function child(raw:JsonObject):void{root(raw);hash(raw['childId']);hash(raw['childPolicyHash']);}

/** Own and validate every format-4 capability command before an await or worker boundary. */
export function workflowTreeCommand(method:WorkflowTreeMethod,input:unknown):JsonObject{
  const raw=object(input);
  switch(method){
    case 'initialize':fields(raw,[]);break;
    case 'submit':{fields(raw,['manifest','policy','resources','input','idempotencyKey']);const manifest=workflowTreeManifest(raw['manifest']);raw['manifest']=manifest as unknown as JsonValue;raw['policy']=workflowTreePolicy(raw['policy']) as unknown as JsonValue;raw['resources']=workflowTreeRootResources(raw['resources'],manifest) as unknown as JsonValue;value(raw,'input');const key=identifier(raw['idempotencyKey'],'Submission key');if(key.length>128)invalid();break;}
    case 'inspect':fields(raw,['scope','rootId','rootPolicyHash']);root(raw);break;
    case 'inspectChild':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash']);child(raw);break;
    case 'admitChild':fields(raw,['scope','rootId','rootPolicyHash','parentId','nodeId','expectedVersion','input']);root(raw);hash(raw['parentId']);identifier(raw['nodeId'],'Node');integer(raw['expectedVersion'],1);value(raw,'input');break;
    case 'requestChildApproval':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','nodeId','expectedVersion','input']);child(raw);identifier(raw['nodeId'],'Node');integer(raw['expectedVersion'],1);value(raw,'input');break;
    case 'approveChildTool':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','nodeId','expectedVersion','digest','humanId']);child(raw);identifier(raw['nodeId'],'Node');integer(raw['expectedVersion'],1);hash(raw['digest']);identifier(raw['humanId'],'Human');break;
    case 'prepareChildTool':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','nodeId','expectedVersion','input']);child(raw);identifier(raw['nodeId'],'Node');integer(raw['expectedVersion'],1);value(raw,'input');break;
    case 'claimPreparedChildTool':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','nodeId','workerId','leaseMs']);child(raw);identifier(raw['nodeId'],'Node');identifier(raw['workerId'],'Worker');integer(raw['leaseMs'],1_000,300_000);break;
    case 'renewClaimedChildTool':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','nodeId','claim','leaseMs']);child(raw);identifier(raw['nodeId'],'Node');claim(raw['claim']);integer(raw['leaseMs'],1_000,300_000);break;
    case 'startClaimedChildTool':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','nodeId','expectedVersion','claim','input']);child(raw);identifier(raw['nodeId'],'Node');integer(raw['expectedVersion'],1);claim(raw['claim']);value(raw,'input');break;
    case 'recordChildToolReceipt':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','nodeId','fence','evidenceId','receipt']);child(raw);identifier(raw['nodeId'],'Node');integer(raw['fence'],1,128);identifier(raw['evidenceId'],'Evidence');raw['receipt']=receipt(raw['receipt']) as unknown as JsonValue;break;
    case 'completeChildTool':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','nodeId','claim','commandId','evidenceId','outcome','output']);child(raw);identifier(raw['nodeId'],'Node');claim(raw['claim']);identifier(raw['commandId'],'Command');identifier(raw['evidenceId'],'Evidence');if(!['succeeded','failed','blocked'].includes(raw['outcome'] as string)||(raw['outcome']!=='succeeded'&&raw['output']!==null))invalid();value(raw,'output');break;
    case 'finalizeChild':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','expectedVersion','output']);child(raw);integer(raw['expectedVersion'],1);value(raw,'output');break;
    case 'joinChild':fields(raw,['scope','rootId','rootPolicyHash','nodeId','expectedVersion']);root(raw);identifier(raw['nodeId'],'Node');integer(raw['expectedVersion'],1);break;
    case 'finalizeRoot':fields(raw,['scope','rootId','rootPolicyHash','expectedVersion','output']);root(raw);integer(raw['expectedVersion'],1);value(raw,'output');break;
    case 'cancelChild':fields(raw,['scope','rootId','rootPolicyHash','childId','childPolicyHash','expectedVersion','commandId']);child(raw);integer(raw['expectedVersion'],1);identifier(raw['commandId'],'Command');break;
    case 'cancelRoot':fields(raw,['scope','rootId','rootPolicyHash','expectedVersion','commandId']);root(raw);integer(raw['expectedVersion'],1);identifier(raw['commandId'],'Command');break;
    case 'recoverExpired':fields(raw,['scope','rootId','rootPolicyHash','limit']);root(raw);integer(raw['limit'],1,128);break;
    default:invalid();
  }
  return raw;
}

function unavailable():never{throw new StorageError('STORAGE_UNAVAILABLE','Invalid workflow-tree storage response.');}
function boolean(value:unknown):boolean{if(typeof value!=='boolean')unavailable();return value;}
function exactObject(value:unknown,names:readonly string[]):JsonObject{let raw:JsonObject;try{raw=object(value);}catch{return unavailable();}try{fields(raw,names);}catch{return unavailable();}return raw;}
function digest(domain:string,value:unknown):string{return createHash('sha256').update(workflowHashMaterial(domain,value)).digest('hex');}
function record(value:unknown,scope:string,id?:string,policyHash?:string):StoredRecord{
  const raw=exactObject(value,['scope','id','idempotencyKey','definitionHash','version','state']);
  try{hash(raw['scope']);hash(raw['id']);identifier(raw['idempotencyKey'],'Idempotency key');hash(raw['definitionHash']);integer(raw['version'],1);}
  catch{return unavailable();}
  if(raw['scope']!==scope||(id!==undefined&&raw['id']!==id))unavailable();
  const decoded=workflowTreeState(raw as unknown as StoredRecord);if(policyHash!==undefined&&decoded.policy!==policyHash)unavailable();
  return raw as unknown as StoredRecord;
}
function rootSnapshot(value:unknown,command:JsonObject):ReturnType<WorkflowTreeStore['inspect']> extends Promise<infer T|undefined>?T:never{
  const raw=exactObject(value,['record','profile','rootId','accountId','manifestHash','policyHash','resourceHash','budget']);
  if(raw['profile']!=='scheduled-v3'||raw['accountId']!=='root')unavailable();
  try{hash(raw['rootId']);hash(raw['manifestHash']);hash(raw['policyHash']);hash(raw['resourceHash']);}catch{return unavailable();}
  const expectedScope=command['scope'] as string;const expectedRoot=command['rootId'] as string;const expectedPolicy=command['rootPolicyHash'] as string;
  if(raw['rootId']!==expectedRoot||raw['policyHash']!==expectedPolicy)unavailable();
  const stored=record(raw['record'],expectedScope,expectedRoot,expectedPolicy);const state=workflowTreeState(stored);
  if(stored.definitionHash!==raw['manifestHash']||state.rootId!==expectedRoot||state.accountId!=='root'||state.definition!==raw['manifestHash'])unavailable();
  const budget=workflowTreeBudgetSnapshot(raw['budget'],{scope:expectedScope,id:expectedRoot,policyHash:expectedPolicy});if(state.budgetVersion!==budget.version)unavailable();
  return raw as never;
}
function member(value:unknown,command:JsonObject,id?:string,policyHash?:string):StoredRecord{
  const result=record(value,command['scope'] as string,id,policyHash);const state=workflowTreeState(result);
  if(state.rootId!==command['rootId']||state.accountId==='root')unavailable();return result;
}
function job(value:unknown,command:JsonObject):JobRecord{
  const raw=exactObject(value,['scope','jobId','runId','nodeId','invocationId','definitionHash','candidateHash','intent','resourceKeys','state','version','fence','workerId','dueAtMs','deadlineAtMs','leaseUntilMs','startedAtMs','leaseRevoked','cancelRequested','receipt','output']);
  try{hash(raw['scope']);hash(raw['jobId']);hash(raw['runId']);identifier(raw['nodeId'],'Node');identifier(raw['invocationId'],'Invocation');hash(raw['definitionHash']);hash(raw['candidateHash']);object(raw['intent']);integer(raw['version'],1);integer(raw['fence'],0,128);integer(raw['dueAtMs']);if(raw['deadlineAtMs']!==null)integer(raw['deadlineAtMs']);if(raw['leaseUntilMs']!==null)integer(raw['leaseUntilMs']);if(raw['startedAtMs']!==null)integer(raw['startedAtMs']);if(raw['receipt']!==null){const evidence=exactObject(raw['receipt'],['callId','toolId','execution','disclosure']);identifier(evidence['callId'],'Receipt call');identifier(evidence['toolId'],'Receipt tool');if(!['not_started','succeeded','failed','unknown'].includes(evidence['execution'] as string)||!['withheld','released'].includes(evidence['disclosure'] as string))unavailable();}jsonValue(raw['output'],{maxBytes:65_536});}
  catch{return unavailable();}
  if(raw['scope']!==command['scope']||raw['runId']!==command['childId']||raw['nodeId']!==command['nodeId']||!['ready','leased','started','succeeded','failed','blocked','cancelled','outcome_unknown'].includes(raw['state'] as string)||!(raw['workerId']===null||typeof raw['workerId']==='string')||typeof raw['leaseRevoked']!=='boolean'||typeof raw['cancelRequested']!=='boolean'||!Array.isArray(raw['resourceKeys'])||raw['resourceKeys'].length>32)unavailable();
  for(const resource of raw['resourceKeys'])try{identifier(resource,'Resource');}catch{return unavailable();}
  return raw as unknown as JobRecord;
}
function claimResult(value:unknown,expectedJob?:JobRecord):ReturnType<typeof claim>{let result:ReturnType<typeof claim>;try{result=claim(value);}catch{return unavailable();}if(expectedJob&&(result.scope!==expectedJob.scope||result.jobId!==expectedJob.jobId||result.fence!==expectedJob.fence||result.workerId!==expectedJob.workerId))unavailable();return result;}
function ownedMember(root:ReturnType<typeof rootSnapshot>,value:unknown,command:JsonObject,id?:string,policyHash?:string):StoredRecord{const stored=member(value,command,id,policyHash);const state=workflowTreeState(stored);if(state.budgetVersion>root.budget.version||!root.budget.accounts.some(account=>account.id===state.accountId))unavailable();return stored;}
function memberResult(value:unknown,command:JsonObject):JsonObject{const raw=exactObject(value,['root','member']);const root=rootSnapshot(raw['root'],command);ownedMember(root,raw['member'],command,command['childId'] as string,command['childPolicyHash'] as string);return raw;}
function array(value:JsonValue|undefined,maximum:number):JsonValue[]{if(!Array.isArray(value)||value.length>maximum)unavailable();return value;}

/** Validate every reply independently of the selected or custom adapter. */
export function workflowTreeResult(method:WorkflowTreeMethod,value:unknown,command:JsonObject):unknown{
  try{
    if(method==='initialize'){if(value!==undefined)unavailable();return undefined;}
    if(method==='inspect'&&value===undefined)return undefined;
    if(method==='submit'){
      const raw=exactObject(value,['snapshot','created']);boolean(raw['created']);const policy=workflowTreePolicy(command['policy']);const scope=digest('mayura:scope:v1',policy.scope);const policyHash=digest('mayura:workflow-tree-policy:v1',policy);const rootId=digest('mayura:workflow-tree-run:v1',{scope,submissionKey:command['idempotencyKey']});const expected={scope,rootId,rootPolicyHash:policyHash} as unknown as JsonObject;const snapshot=rootSnapshot(raw['snapshot'],expected);
      if(snapshot.manifestHash!==digest('mayura:workflow-tree:v1',command['manifest'])||snapshot.resourceHash!==digest('mayura:workflow-tree-resources:v1',command['resources']))unavailable();return immutable(raw);
    }
    if(method==='inspect'||method==='joinChild'||method==='finalizeRoot')return immutable(rootSnapshot(value,command));
    if(method==='inspectChild'||method==='requestChildApproval'||method==='approveChildTool'||method==='finalizeChild')return immutable(memberResult(value,command));
    if(method==='admitChild'){
      const raw=exactObject(value,['root','child','childId','accountId','definitionHash','policyHash','resourceHash','inputHash','created']);boolean(raw['created']);for(const name of ['childId','definitionHash','policyHash','resourceHash','inputHash'])try{hash(raw[name]);}catch{return unavailable();}if(typeof raw['accountId']!=='string')unavailable();const root=rootSnapshot(raw['root'],command);const state=workflowTreeState(root.record);const link=state.steps[command['nodeId'] as string]?.child;if(!link||link.runId!==raw['childId']||link.accountId!==raw['accountId']||link.definitionHash!==raw['definitionHash']||link.policyHash!==raw['policyHash']||link.inputHash!==raw['inputHash'])unavailable();const child=ownedMember(root,raw['child'],command,raw['childId'] as string,raw['policyHash'] as string);if(workflowTreeState(child).accountId!==raw['accountId'])unavailable();return immutable(raw);
    }
    if(method==='prepareChildTool'){
      const raw=exactObject(value,['root','member','job','created']);boolean(raw['created']);const root=rootSnapshot(raw['root'],command);ownedMember(root,raw['member'],command,command['childId'] as string,command['childPolicyHash'] as string);job(raw['job'],command);return immutable(raw);
    }
    if(method==='claimPreparedChildTool'){
      if(value===undefined)return undefined;const raw=exactObject(value,['root','member','job','claim']);const root=rootSnapshot(raw['root'],command);ownedMember(root,raw['member'],command,command['childId'] as string,command['childPolicyHash'] as string);const storedJob=job(raw['job'],command);claimResult(raw['claim'],storedJob);return immutable(raw);
    }
    if(method==='renewClaimedChildTool'){
      const raw=exactObject(value,['root','member','claim']);rootSnapshot(raw['root'],command);member(raw['member'],command,command['childId'] as string,command['childPolicyHash'] as string);const renewed=claimResult(raw['claim']);const original=command['claim'] as unknown as ReturnType<typeof claim>;if(renewed.scope!==original.scope||renewed.jobId!==original.jobId||renewed.workerId!==original.workerId||renewed.fence!==original.fence||renewed.leaseUntilMs<original.leaseUntilMs)unavailable();return immutable(raw);
    }
    if(method==='startClaimedChildTool'){
      const raw=exactObject(value,['status','root','member','job']);if(!['started','already_started'].includes(raw['status'] as string))unavailable();rootSnapshot(raw['root'],command);member(raw['member'],command,command['childId'] as string,command['childPolicyHash'] as string);const storedJob=job(raw['job'],command);const original=command['claim'] as unknown as ReturnType<typeof claim>;if(storedJob.jobId!==original.jobId||storedJob.fence!==original.fence)unavailable();return immutable(raw);
    }
    if(method==='recordChildToolReceipt'){
      const raw=exactObject(value,['disposition','root','member','job']);if(!['current','late','conflicting'].includes(raw['disposition'] as string))unavailable();rootSnapshot(raw['root'],command);member(raw['member'],command,command['childId'] as string,command['childPolicyHash'] as string);const storedJob=job(raw['job'],command);if(storedJob.fence!==command['fence'])unavailable();return immutable(raw);
    }
    if(method==='completeChildTool'){
      const raw=exactObject(value,['root','member','job']);rootSnapshot(raw['root'],command);member(raw['member'],command,command['childId'] as string,command['childPolicyHash'] as string);const storedJob=job(raw['job'],command);const original=command['claim'] as unknown as ReturnType<typeof claim>;if(storedJob.jobId!==original.jobId||storedJob.fence!==original.fence)unavailable();return immutable(raw);
    }
    if(method==='cancelChild'){
      const raw=exactObject(value,['root','member','jobs']);const root=rootSnapshot(raw['root'],command);ownedMember(root,raw['member'],command,command['childId'] as string,command['childPolicyHash'] as string);for(const item of array(raw['jobs'],128))job(item,{...command,nodeId:(item as JsonObject)['nodeId']} as JsonObject);return immutable(raw);
    }
    if(method==='cancelRoot'||method==='recoverExpired'){
      const raw=exactObject(value,['root','members','jobs']);const root=rootSnapshot(raw['root'],command);const members=array(raw['members'],16).map(item=>ownedMember(root,item,command));const ids=new Set(members.map(item=>item.id));if(ids.size!==members.length)unavailable();for(const item of array(raw['jobs'],128)){const stored=job(item,{...command,childId:(item as JsonObject)['runId'],nodeId:(item as JsonObject)['nodeId']} as JsonObject);if(!ids.has(stored.runId))unavailable();}return immutable(raw);
    }
    unavailable();
  }catch(error){if(error instanceof StorageError&&error.code==='STORAGE_UNAVAILABLE')throw error;return unavailable();}
}

/** Finite optional adapter facade; base aggregate adapters remain source-compatible. */
export function workflowTreeFacade(request:(method:WorkflowTreeMethod,input:JsonObject)=>Promise<unknown>):WorkflowTreeStore{
  const call=async<T>(method:WorkflowTreeMethod,input:unknown):Promise<T>=>{const command=workflowTreeCommand(method,input);const result=await request(method,command);return workflowTreeResult(method,result,command) as T;};
  return Object.freeze({
    initialize:()=>call<void>('initialize',{}),submit:value=>call('submit',value),inspect:value=>call('inspect',value),inspectChild:value=>call('inspectChild',value),admitChild:value=>call('admitChild',value),requestChildApproval:value=>call('requestChildApproval',value),approveChildTool:value=>call('approveChildTool',value),
    prepareChildTool:value=>call('prepareChildTool',value),claimPreparedChildTool:value=>call('claimPreparedChildTool',value),renewClaimedChildTool:value=>call('renewClaimedChildTool',value),startClaimedChildTool:value=>call('startClaimedChildTool',value),
    recordChildToolReceipt:value=>call('recordChildToolReceipt',value),completeChildTool:value=>call('completeChildTool',value),finalizeChild:value=>call('finalizeChild',value),joinChild:value=>call('joinChild',value),finalizeRoot:value=>call('finalizeRoot',value),
    cancelChild:value=>call('cancelChild',value),cancelRoot:value=>call('cancelRoot',value),recoverExpired:value=>call('recoverExpired',value),
  } satisfies WorkflowTreeStore);
}
