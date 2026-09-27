import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError } from './contracts.js';
import type { WorkflowTreeAggregateStore } from './workflow-tree-contracts.js';

export interface WorkflowTreeDiscoveryCursor {
  readonly format:1;readonly scope:string;readonly policyHash:string;readonly afterId:string;
}
export interface WorkflowTreeDiscoveryCandidate {
  readonly rootId:string;readonly definitionHash:string;readonly policyHash:string;readonly version:number;readonly status:'running'|'waiting'|'paused';
}
export interface WorkflowTreeDiscoveryPage {
  readonly candidates:readonly WorkflowTreeDiscoveryCandidate[];readonly examined:number;readonly nextCursor:WorkflowTreeDiscoveryCursor|null;
}
export interface WorkflowTreeDiscoveryScan {
  readonly scope:string;readonly policyHash:string;readonly cursor:WorkflowTreeDiscoveryCursor|null;readonly limit:number;
}
export interface WorkflowTreeDiscoveryStore {
  initialize():Promise<void>;scan(command:WorkflowTreeDiscoveryScan):Promise<WorkflowTreeDiscoveryPage>;
}
export interface WorkflowTreeDiscoveryAggregateStore extends WorkflowTreeAggregateStore {
  readonly workflowTreeDiscovery:WorkflowTreeDiscoveryStore;
}
export type WorkflowTreeDiscoveryMethod=keyof WorkflowTreeDiscoveryStore;

const HASH=/^[a-f0-9]{64}$/;
function invalid():never{throw new StorageError('INVALID_INPUT','Invalid bounded workflow-tree discovery metadata.');}
function object(value:JsonValue|undefined):JsonObject{if(value===null||typeof value!=='object'||Array.isArray(value))invalid();return value;}
function fields(value:JsonObject,names:readonly string[]):void{if(Object.keys(value).length!==names.length||names.some(name=>!Object.hasOwn(value,name)))invalid();}
function hash(value:unknown):string{if(typeof value!=='string'||!HASH.test(value))invalid();return value;}
function integer(value:unknown,min:number,max=Number.MAX_SAFE_INTEGER):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)invalid();return value;}
function owned<T>(raw:unknown,check:(value:JsonObject)=>void):T{try{const value=object(jsonValue(raw,{maxBytes:65_536,maxNodes:4_096,maxDepth:12}));check(value);return freezeJson(value) as unknown as T;}catch{return invalid();}}
function cursorFields(value:JsonObject,scope?:string,policy?:string):void{fields(value,['format','scope','policyHash','afterId']);if(value['format']!==1)invalid();hash(value['scope']);hash(value['policyHash']);hash(value['afterId']);if((scope!==undefined&&value['scope']!==scope)||(policy!==undefined&&value['policyHash']!==policy))invalid();}

export function workflowTreeDiscoveryCursor(raw:unknown):WorkflowTreeDiscoveryCursor{return owned(raw,value=>cursorFields(value));}
export function workflowTreeDiscoveryCommand(method:WorkflowTreeDiscoveryMethod,raw:unknown):JsonObject{return owned(raw,value=>{if(method==='initialize'){fields(value,[]);return;}if(method!=='scan')invalid();fields(value,['scope','policyHash','cursor','limit']);const scope=hash(value['scope']);const policy=hash(value['policyHash']);integer(value['limit'],1,32);if(value['cursor']!==null)cursorFields(object(value['cursor']),scope,policy);});}
export function workflowTreeDiscoveryPage(raw:unknown,context:WorkflowTreeDiscoveryScan):WorkflowTreeDiscoveryPage{
  const command=workflowTreeDiscoveryCommand('scan',context);const scope=command['scope'] as string;const policy=command['policyHash'] as string;const limit=command['limit'] as number;const afterId=command['cursor']===null?'':object(command['cursor'])['afterId'] as string;
  return owned(raw,value=>{fields(value,['candidates','examined','nextCursor']);const examined=integer(value['examined'],0,limit);if(!Array.isArray(value['candidates'])||value['candidates'].length>examined)invalid();let lastId=afterId;for(const rawCandidate of value['candidates']){const candidate=object(rawCandidate);fields(candidate,['rootId','definitionHash','policyHash','version','status']);const rootId=hash(candidate['rootId']);hash(candidate['definitionHash']);if(hash(candidate['policyHash'])!==policy||rootId<=lastId||!['running','waiting','paused'].includes(candidate['status'] as string))invalid();integer(candidate['version'],1);lastId=rootId;}if(examined===limit){const cursor=object(value['nextCursor']);cursorFields(cursor,scope,policy);const next=cursor['afterId'] as string;if(next<=afterId||next<lastId||(value['candidates'].length===examined&&next!==lastId))invalid();}else if(value['nextCursor']!==null)invalid();});
}
