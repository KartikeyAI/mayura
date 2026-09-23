import { jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import {
  workflowTreeManifest, workflowTreePolicy, workflowTreeRootResources,
  type WorkflowTreeMethod, type WorkflowTreeStore,
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
    case 'admitChild':fields(raw,['scope','rootId','rootPolicyHash','parentId','nodeId','expectedVersion','input']);root(raw);hash(raw['parentId']);identifier(raw['nodeId'],'Node');integer(raw['expectedVersion'],1);value(raw,'input');break;
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

/** Finite optional adapter facade; base aggregate adapters remain source-compatible. */
export function workflowTreeFacade(request:(method:WorkflowTreeMethod,input:JsonObject)=>Promise<unknown>):WorkflowTreeStore{
  const call=async<T>(method:WorkflowTreeMethod,input:unknown):Promise<T>=>{const result=await request(method,workflowTreeCommand(method,input));return result===undefined?undefined as T:immutable(result) as T;};
  return Object.freeze({
    initialize:()=>call<void>('initialize',{}),submit:value=>call('submit',value),inspect:value=>call('inspect',value),admitChild:value=>call('admitChild',value),
    prepareChildTool:value=>call('prepareChildTool',value),claimPreparedChildTool:value=>call('claimPreparedChildTool',value),renewClaimedChildTool:value=>call('renewClaimedChildTool',value),startClaimedChildTool:value=>call('startClaimedChildTool',value),
    recordChildToolReceipt:value=>call('recordChildToolReceipt',value),completeChildTool:value=>call('completeChildTool',value),finalizeChild:value=>call('finalizeChild',value),joinChild:value=>call('joinChild',value),finalizeRoot:value=>call('finalizeRoot',value),
    cancelChild:value=>call('cancelChild',value),cancelRoot:value=>call('cancelRoot',value),recoverExpired:value=>call('recoverExpired',value),
  } satisfies WorkflowTreeStore);
}
