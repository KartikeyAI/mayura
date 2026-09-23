import { describe, expect, it } from 'vitest';
import { workflowTreeFacade } from '../src/workflow-tree-validation.js';

const leaf={id:'leaf',version:'1',graph:[{kind:'tool' as const,id:'work',dependsOn:[],tool:'fixture/tool',toolVersion:'1',effects:'none' as const,capabilities:[],costMicros:1,approval:false,input:{kind:'input' as const,path:[]}}],result:{kind:'step' as const,stepId:'work',path:[]}};
const manifest={format:4 as const,id:'root',version:'1',graph:[{kind:'child' as const,id:'child',dependsOn:[],workflow:leaf,policy:{permissions:['tool:fixture/tool'],maxCostMicros:1,maxCalls:1,maxOutputBytes:128,approvalTtlMs:1_000},resources:{work:[]},input:{kind:'input' as const,path:[]}}],result:{kind:'step' as const,stepId:'child',path:[]}};
const policy={scope:{principalId:'owner',projectId:'project'},permissions:['tool:fixture/tool'],policyVersion:'1',maxCostMicros:1,maxCalls:1,maxOutputBytes:128,approvalTtlMs:1_000};

describe('workflow-tree public facade',()=>{
  it('snapshots canonical submission material before awaiting transport',async()=>{
    const seen:unknown[]=[];const api=workflowTreeFacade(async(method,input)=>{seen.push([method,input]);return undefined;});const mutable=structuredClone({manifest,policy,resources:{},input:{value:1},idempotencyKey:'root'});const pending=api.submit(mutable);mutable.policy.permissions.push('changed');mutable.input.value=2;await pending;expect(seen).toEqual([['submit',expect.objectContaining({manifest,policy:expect.objectContaining({permissions:['tool:fixture/tool']}),input:{value:1}})]]);
  });

  it('rejects unknown fields and malformed exact identities before transport',async()=>{
    let calls=0;const api=workflowTreeFacade(async()=>{calls++;return undefined;});await expect(api.inspect({scope:'a'.repeat(64),rootId:'b'.repeat(64),rootPolicyHash:'c'.repeat(64),extra:true} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(api.recoverExpired({scope:'bad',rootId:'b'.repeat(64),rootPolicyHash:'c'.repeat(64),limit:1})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(calls).toBe(0);
  });

  it('returns detached deeply immutable transport values',async()=>{
    const source={nested:{value:1}};const api=workflowTreeFacade(async()=>source);const result=await api.inspect({scope:'a'.repeat(64),rootId:'b'.repeat(64),rootPolicyHash:'c'.repeat(64)}) as unknown as typeof source;source.nested.value=2;expect(result.nested.value).toBe(1);expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.nested)).toBe(true);
  });
});
