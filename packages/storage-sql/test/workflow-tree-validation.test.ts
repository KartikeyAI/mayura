import { describe, expect, it, vi } from 'vitest';
import { workflowTreeFacade } from '../src/workflow-tree-validation.js';

const leaf={id:'leaf',version:'1',graph:[{kind:'tool' as const,id:'work',dependsOn:[],tool:'fixture/tool',toolVersion:'1',effects:'none' as const,capabilities:[],costMicros:1,approval:false,input:{kind:'input' as const,path:[]}}],result:{kind:'step' as const,stepId:'work',path:[]}};
const manifest={format:4 as const,id:'root',version:'1',graph:[{kind:'child' as const,id:'child',dependsOn:[],workflow:leaf,policy:{permissions:['tool:fixture/tool'],maxCostMicros:1,maxCalls:1,maxOutputBytes:128,approvalTtlMs:1_000},resources:{work:[]},input:{kind:'input' as const,path:[]}}],result:{kind:'step' as const,stepId:'child',path:[]}};
const policy={scope:{principalId:'owner',projectId:'project'},permissions:['tool:fixture/tool'],policyVersion:'1',maxCostMicros:1,maxCalls:1,maxOutputBytes:128,approvalTtlMs:1_000};
const scope='a'.repeat(64);const rootId='b'.repeat(64);const policyHash='c'.repeat(64);const definitionHash='d'.repeat(64);const resourceHash='e'.repeat(64);
function snapshot(){return{record:{scope,id:rootId,idempotencyKey:'root',definitionHash,version:1,state:{format:4,rootId,accountId:'root',definition:definitionHash,policy:policyHash,input:null,status:'running',steps:{child:{kind:'child',status:'pending',callId:'step:child',output:null,receipt:null,approval:null,costReserved:0,candidateHash:null,child:null}},maxCostMicros:1,maxCalls:1,spentMicros:0,reservedMicros:0,budgetVersion:1,output:null}},profile:'scheduled-v3' as const,rootId,accountId:'root' as const,manifestHash:definitionHash,policyHash,resourceHash,budget:{format:1 as const,mode:'shared-ceiling-v1' as const,owner:'workflow-tree-v1' as const,scope,id:rootId,policyHash,version:1,eventSequence:1,blocked:false,accounts:[{id:'root',parentId:null,maxCostMicros:1,maxCalls:1,closed:false,spentMicros:0,reservedMicros:0,calls:0,heldCalls:0}],bundles:[],reservations:[]}};}

describe('workflow-tree public facade',()=>{
  it('snapshots canonical submission material before awaiting transport',async()=>{
    const seen:unknown[]=[];const api=workflowTreeFacade(async(method,input)=>{seen.push([method,input]);return undefined;});const mutable=structuredClone({manifest,policy,resources:{},input:{value:1},idempotencyKey:'root'});const pending=api.submit(mutable);mutable.policy.permissions.push('changed');mutable.input.value=2;await expect(pending).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});expect(seen).toEqual([['submit',expect.objectContaining({manifest,policy:expect.objectContaining({permissions:['tool:fixture/tool']}),input:{value:1}})]]);
  });

  it('rejects unknown fields and malformed exact identities before transport',async()=>{
    let calls=0;const api=workflowTreeFacade(async()=>{calls++;return undefined;});await expect(api.inspect({scope,rootId,rootPolicyHash:policyHash,extra:true} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(api.recoverExpired({scope:'bad',rootId,rootPolicyHash:policyHash,limit:1})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(calls).toBe(0);
  });

  it('returns detached deeply immutable transport values',async()=>{
    const source=snapshot();const api=workflowTreeFacade(async()=>source);const result=await api.inspect({scope,rootId,rootPolicyHash:policyHash});source.record.state.status='failed';expect(result!.record.state['status']).toBe('running');expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result!.record.state)).toBe(true);
  });

  it('rejects hostile custom-adapter identities, projections and reflection',async()=>{
    const altered=[{...snapshot(),rootId:'f'.repeat(64)},{...snapshot(),policyHash:'f'.repeat(64)},{...snapshot(),record:{...snapshot().record,definitionHash:'f'.repeat(64)}},{...snapshot(),budget:{...snapshot().budget,version:2,eventSequence:2}}];
    for(const response of altered)await expect(workflowTreeFacade(async()=>response).inspect({scope,rootId,rootPolicyHash:policyHash})).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
    const getter=vi.fn(()=>snapshot().record);const hostile=Object.defineProperty({...snapshot()},'record',{enumerable:true,get:getter});await expect(workflowTreeFacade(async()=>hostile).inspect({scope,rootId,rootPolicyHash:policyHash})).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});expect(getter).not.toHaveBeenCalled();
  });
});
