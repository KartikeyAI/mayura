import { describe,expect,it } from 'vitest';
import { createWorkflowTreeDiscovery } from '../src/children.js';

const rootId='a'.repeat(64);const definitionHash='b'.repeat(64);
const options={scope:{principalId:'discovery',projectId:'project'},permissions:{allow:['tool:fixture']},policyVersion:'1',maxCostMicros:1,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000} as const;

describe('workflow-tree discovery facade',()=>{
  it('returns immutable bounded hints without execution authority',async()=>{let command:{scope:string;policyHash:string}|undefined;const store={workflowTreeDiscovery:{initialize:async()=>{},scan:async(value:{scope:string;policyHash:string;cursor:null;limit:number})=>{command=value;return{candidates:[{rootId,definitionHash,policyHash:value.policyHash,version:3,status:'waiting' as const}],examined:1,nextCursor:null};}}};const discovery=createWorkflowTreeDiscovery({store:store as never,...options});const page=await discovery.scan({limit:2});expect(command).toMatchObject({scope:expect.stringMatching(/^[a-f0-9]{64}$/),policyHash:expect.stringMatching(/^[a-f0-9]{64}$/)});expect(page).toMatchObject({candidates:[{rootId,definitionHash,version:3,status:'waiting'}],examined:1,nextCursor:null});expect(Object.isFrozen(page)).toBe(true);await discovery.close();await expect(discovery.scan()).rejects.toMatchObject({code:'CANCELLED'});});
  it('rejects malformed adapter identity metadata',async()=>{const store={workflowTreeDiscovery:{initialize:async()=>{},scan:async(value:{policyHash:string})=>({candidates:[{rootId,definitionHash,policyHash:value.policyHash,version:1,status:'succeeded'}],examined:1,nextCursor:null})}};const discovery=createWorkflowTreeDiscovery({store:store as never,...options});await expect(discovery.scan()).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});});
  it('requires the optional capability',()=>{expect(()=>createWorkflowTreeDiscovery({store:{} as never,...options})).toThrow(expect.objectContaining({code:'UNSUPPORTED_PROFILE'}));});
});
