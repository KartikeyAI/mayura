import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type StoredRecord } from './contracts.js';
import type { WorkflowManifest, WorkflowResourcePlan } from './scheduled-workflow-contracts.js';
import type { WorkflowTreeManifest, WorkflowTreePolicyManifest } from './workflow-tree-contracts.js';
import { workflowManifest } from './workflow-format2.js';
import { workflowTreeManifest, workflowTreePolicy, workflowTreeRootResources } from './workflow-tree-contracts.js';

export type WorkflowTreeStatus = 'running'|'waiting'|'succeeded'|'failed'|'blocked'|'cancelled'|'outcome_unknown';
export type WorkflowTreeStepStatus = 'pending'|'waiting'|'approved'|'dispatching'|'succeeded'|'failed'|'blocked'|'unknown'|'skipped';
export interface WorkflowTreeChildLink {
  readonly runId: string; readonly accountId: string; readonly definitionHash: string;
  readonly policyHash: string; readonly inputHash: string; readonly joinedVersion: number|null;
}
export interface WorkflowTreeStep {
  readonly kind: 'tool'|'join'|'child'; status: WorkflowTreeStepStatus; readonly callId: string;
  output: JsonValue; receipt: JsonValue; approval: JsonValue; costReserved: number;
  candidateHash: string|null; child: WorkflowTreeChildLink|null;
}
export interface WorkflowTreeState {
  readonly format: 4; readonly rootId: string; readonly accountId: string;
  readonly definition: string; readonly policy: string; readonly input: JsonValue;
  status: WorkflowTreeStatus; readonly steps: Record<string,WorkflowTreeStep>;
  readonly maxCostMicros: number; readonly maxCalls: number; spentMicros: number;
  reservedMicros: number; budgetVersion: number; output: JsonValue;
}

const hashPattern = /^[a-f0-9]{64}$/;
function invalid(): never { throw new StorageError('INVALID_INPUT','Invalid bounded workflow-tree state.'); }
function corrupt(): never { throw new StorageError('CONFLICT','Stored workflow-tree state failed integrity validation.'); }
function hash(value: unknown): string { if (typeof value !== 'string' || !hashPattern.test(value)) invalid(); return value; }
function integer(value: unknown,minimum=0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(); return value; }
function object(value: JsonValue|undefined): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
function fields(value: JsonObject,names: readonly string[]): void { if (Object.keys(value).length !== names.length || names.some(name=>!Object.hasOwn(value,name))) invalid(); }

function initial(
  rootId: string, accountId: string, definitionHash: string, policyHash: string, input: JsonValue,
  nodes: readonly {readonly id:string;readonly kind:'tool'|'join'|'child'}[], maxCostMicros: number, maxCalls: number,
): WorkflowTreeState {
  hash(rootId); hash(definitionHash); hash(policyHash); integer(maxCostMicros); integer(maxCalls,1);
  return freezeJson(jsonValue({format:4,rootId,accountId,definition:definitionHash,policy:policyHash,input,status:'running',
    steps:Object.fromEntries(nodes.map(node=>[node.id,{kind:node.kind,status:'pending',callId:`step:${node.id}`,
      output:null,receipt:null,approval:null,costReserved:0,candidateHash:null,child:null}])),
    maxCostMicros,maxCalls,spentMicros:0,reservedMicros:0,budgetVersion:1,output:null})) as unknown as WorkflowTreeState;
}

export function initialWorkflowTreeRootState(definition: WorkflowTreeManifest,input: JsonValue,rootId:string,definitionHash:string,policyHash:string,policy:WorkflowTreePolicyManifest): WorkflowTreeState {
  const manifest=workflowTreeManifest(definition); const authority=workflowTreePolicy(policy);
  return initial(rootId,'root',definitionHash,policyHash,jsonValue(input,{maxBytes:authority.maxOutputBytes}),manifest.graph,authority.maxCostMicros,authority.maxCalls);
}

export function initialWorkflowTreeLeafState(definition: WorkflowManifest,input: JsonValue,rootId:string,accountId:string,definitionHash:string,policyHash:string,policy:WorkflowTreePolicyManifest): WorkflowTreeState {
  const manifest=workflowManifest(definition); const authority=workflowTreePolicy(policy);
  return initial(rootId,accountId,definitionHash,policyHash,jsonValue(input,{maxBytes:authority.maxOutputBytes}),manifest.graph,authority.maxCostMicros,authority.maxCalls);
}

/** Strict structural decoder; manifest/owner/account projections are checked by storage under the root lock. */
export function workflowTreeState(record: Pick<StoredRecord,'id'|'state'>): WorkflowTreeState {
  try {
    const idDescriptor=Object.getOwnPropertyDescriptor(record,'id'); const stateDescriptor=Object.getOwnPropertyDescriptor(record,'state');
    if(!idDescriptor||!('value'in idDescriptor)||!stateDescriptor||!('value'in stateDescriptor)) corrupt(); hash(idDescriptor.value);
    const state=object(jsonValue(stateDescriptor.value));
    fields(state,['format','rootId','accountId','definition','policy','input','status','steps','maxCostMicros','maxCalls','spentMicros','reservedMicros','budgetVersion','output']);
    if(state['format']!==4||!['running','waiting','succeeded','failed','blocked','cancelled','outcome_unknown'].includes(state['status'] as string)) corrupt();
    hash(state['rootId']); hash(state['definition']); hash(state['policy']);
    if(typeof state['accountId']!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(state['accountId'])) corrupt();
    integer(state['maxCostMicros']); integer(state['maxCalls'],1); const spent=integer(state['spentMicros']); const reserved=integer(state['reservedMicros']); integer(state['budgetVersion'],1);
    if(spent+reserved>Number(state['maxCostMicros'])) corrupt();
    const steps=object(state['steps']); if(!Object.keys(steps).length||Object.keys(steps).length>128) corrupt(); let projected=0;
    for(const [nodeId,raw] of Object.entries(steps)) {
      if(!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(nodeId)) corrupt(); const step=object(raw);
      fields(step,['kind','status','callId','output','receipt','approval','costReserved','candidateHash','child']);
      if(!['tool','join','child'].includes(step['kind'] as string)||!['pending','waiting','approved','dispatching','succeeded','failed','blocked','unknown','skipped'].includes(step['status'] as string)||step['callId']!==`step:${nodeId}`) corrupt();
      projected+=integer(step['costReserved']); if(step['candidateHash']!==null) hash(step['candidateHash']);
      if(step['kind']!=='tool'&&(step['receipt']!==null||step['approval']!==null||step['costReserved']!==0)) corrupt();
      if(step['kind']!=='child'&&step['child']!==null) corrupt();
      if(step['kind']==='child'&&step['child']!==null){const link=object(step['child']);fields(link,['runId','accountId','definitionHash','policyHash','inputHash','joinedVersion']);hash(link['runId']);hash(link['definitionHash']);hash(link['policyHash']);hash(link['inputHash']);if(typeof link['accountId']!=='string')corrupt();if(link['joinedVersion']!==null)integer(link['joinedVersion'],1);}
      if(step['status']!=='succeeded'&&step['output']!==null) corrupt();
    }
    if(projected!==reserved||(state['status']!=='succeeded'&&state['output']!==null)) corrupt();
    return state as unknown as WorkflowTreeState;
  } catch{return corrupt();}
}

export function assertWorkflowTreeRootState(state:WorkflowTreeState,definition:WorkflowTreeManifest,policy:WorkflowTreePolicyManifest,resources:WorkflowResourcePlan):void {
  try{const manifest=workflowTreeManifest(definition);const authority=workflowTreePolicy(policy);workflowTreeRootResources(resources,manifest);
    if(state.accountId!=='root'||state.rootId===undefined||state.maxCostMicros!==authority.maxCostMicros||state.maxCalls!==authority.maxCalls||Object.keys(state.steps).length!==manifest.graph.length)corrupt();
    for(const node of manifest.graph)if(state.steps[node.id]?.kind!==node.kind)corrupt();
  }catch{return corrupt();}
}
