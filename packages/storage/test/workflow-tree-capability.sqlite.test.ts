import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { workflowTreeState, type WorkflowTreeManifest, type WorkflowTreePolicyManifest } from '@mayura/storage-contracts';

const leaf={id:'leaf',version:'1',graph:[{kind:'tool' as const,id:'work',dependsOn:[],tool:'fixture/tool',toolVersion:'1',effects:'none' as const,capabilities:[],costMicros:2,approval:false,input:{kind:'input' as const,path:[]}}],result:{kind:'step' as const,stepId:'work',path:[]}};
const manifest:WorkflowTreeManifest={format:4,id:'root',version:'1',graph:[{kind:'child',id:'child',dependsOn:[],workflow:leaf,policy:{permissions:['tool:fixture/tool'],maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{work:[]},input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'child',path:[]}};
const policy:WorkflowTreePolicyManifest={scope:{principalId:'owner',projectId:'project'},permissions:['tool:fixture/tool'],policyVersion:'1',maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000};

describe('SQLite public workflow-tree capability',()=>{
  const stores:ReturnType<typeof createSqliteStore>[]=[];afterEach(async()=>{await Promise.all(stores.splice(0).map(store=>store.close()));});

  it('runs the bounded child lifecycle through the worker facade and renews one lease',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();await store.workflowTrees.initialize();const api=store.workflowTrees;
    const submitted=await api.submit({manifest,policy,resources:{},input:null,idempotencyKey:'public-root'});const root=submitted.snapshot;expect(Object.isFrozen(root)).toBe(true);expect(root.profile).toBe('scheduled-v3');
    const child=await api.admitChild({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,parentId:root.rootId,nodeId:'child',expectedVersion:1,input:null});await store.workflowTreeDiscovery.initialize();const page=await store.workflowTreeDiscovery.scan({scope:root.record.scope,policyHash:root.policyHash,cursor:null,limit:32});expect(page).toMatchObject({candidates:[{rootId:root.rootId,definitionHash:root.record.definitionHash,status:'waiting'}],examined:2,nextCursor:null});const common={scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,childId:child.childId,childPolicyHash:child.policyHash,nodeId:'work'};
    await api.prepareChildTool({...common,expectedVersion:1,input:null});const claimed=await api.claimPreparedChildTool({...common,workerId:'worker',leaseMs:1_000});if(!claimed)throw new Error('fixture');const renewed=await api.renewClaimedChildTool({...common,claim:claimed.claim,leaseMs:2_000});expect(renewed.claim).toMatchObject({fence:1,workerId:'worker'});expect(renewed.claim.leaseUntilMs).toBeGreaterThanOrEqual(claimed.claim.leaseUntilMs);
    await api.startClaimedChildTool({...common,expectedVersion:renewed.member.version,claim:renewed.claim,input:null});const receipt={callId:`${child.childId}/step:work`,toolId:'fixture/tool',execution:'succeeded' as const,disclosure:'withheld' as const};await api.recordChildToolReceipt({...common,fence:renewed.claim.fence,evidenceId:'known',receipt});const completed=await api.completeChildTool({...common,claim:renewed.claim,commandId:'complete',evidenceId:'known',outcome:'succeeded',output:{answer:42}});const finalized=await api.finalizeChild({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,childId:child.childId,childPolicyHash:child.policyHash,expectedVersion:completed.member.version,output:{answer:42}});const joined=await api.joinChild({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,nodeId:'child',expectedVersion:finalized.root.record.version});const finished=await api.finalizeRoot({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash,expectedVersion:joined.record.version,output:{answer:42}});
    expect(workflowTreeState(finished.record)).toMatchObject({status:'succeeded',output:{answer:42}});expect(finished.budget.accounts.every(account=>account.closed)).toBe(true);expect(await api.inspect({scope:root.record.scope,rootId:root.rootId,rootPolicyHash:root.policyHash})).toEqual(finished);
  });

  it('rejects malformed commands before IPC persistence',async()=>{
    const store=createSqliteStore({filename:':memory:'});stores.push(store);await store.initialize();await store.workflowTrees.initialize();await expect(store.workflowTrees.inspect({scope:'not-a-hash',rootId:'x',rootPolicyHash:'y'})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(await store.read('not-a-hash','x')).toBeUndefined();
  });
});
