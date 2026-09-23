import { describe, expect, it } from 'vitest';
import { workflowTreeManifest } from '../src/workflow-tree-contracts.js';

const leaf = { id:'leaf',version:'1',graph:[{kind:'tool',id:'work',dependsOn:[],tool:'fixture/tool',toolVersion:'1',effects:'none',capabilities:[],costMicros:2,approval:false,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]} };
const child = (id='child') => ({ kind:'child',id,dependsOn:[],workflow:leaf,
  policy:{permissions:['tool:fixture/tool'],maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},
  resources:{work:['resource/a']},input:{kind:'input',path:[]} });
const tree = { format:4,id:'root',version:'1',graph:[child()],result:{kind:'step',stepId:'child',path:[]} };

describe('workflow tree manifest contract', () => {
  it('owns and canonicalizes a bounded one-level tree', () => {
    const permissions = ['z','a']; const raw = structuredClone(tree); raw.graph[0]!.policy.permissions = permissions;
    const manifest = workflowTreeManifest(raw);
    permissions.push('changed');
    expect(manifest).toMatchObject({format:4,graph:[{kind:'child',policy:{permissions:['a','z']},resources:{work:['resource/a']}}]});
    expect(Object.isFrozen(manifest)).toBe(true); expect(Object.isFrozen(manifest.graph[0])).toBe(true);
  });

  it('rejects recursive children and authority that cannot fund its leaf', () => {
    expect(() => workflowTreeManifest({...tree,graph:[{...child(),workflow:tree}]})).toThrow();
    expect(() => workflowTreeManifest({...tree,graph:[{...child(),policy:{...child().policy,maxCalls:0}}]})).toThrow();
    expect(() => workflowTreeManifest({...tree,graph:[{...child(),policy:{...child().policy,maxCostMicros:1}}]})).toThrow();
  });

  it('enforces whole-tree child, tool, node, dependency and metadata ceilings', () => {
    expect(() => workflowTreeManifest({...tree,graph:Array.from({length:17},(_,index)=>child(`child${index}`))})).toThrow();
    const manyTools = {...leaf,graph:Array.from({length:128},(_,index)=>({...leaf.graph[0],id:`tool${index}`})),result:{kind:'literal',value:null}};
    expect(() => workflowTreeManifest({...tree,graph:[{...child(),workflow:manyTools,policy:{...child().policy,maxCostMicros:256,maxCalls:128}}]})).toThrow();
    expect(() => workflowTreeManifest({...tree,graph:[{...child(),dependsOn:['missing']}]})).toThrow();
    expect(() => workflowTreeManifest({...tree,version:'x'.repeat(1_048_576)})).toThrow();
  });
});
