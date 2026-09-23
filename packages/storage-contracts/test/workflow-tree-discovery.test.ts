import { describe,expect,it } from 'vitest';
import { workflowTreeDiscoveryCommand,workflowTreeDiscoveryCursor,workflowTreeDiscoveryPage } from '../src/index.js';

const hash=(value:string)=>value.repeat(64).slice(0,64);
const scope=hash('a');const policyHash=hash('b');const rootId=hash('c');const definitionHash=hash('d');

describe('workflow-tree discovery contracts',()=>{
  it('owns exact bounded commands, cursors and pages',()=>{const cursor=workflowTreeDiscoveryCursor({format:1,scope,policyHash,afterId:rootId});expect(cursor).toEqual({format:1,scope,policyHash,afterId:rootId});expect(Object.isFrozen(cursor)).toBe(true);const command=workflowTreeDiscoveryCommand('scan',{scope,policyHash,cursor:null,limit:1});const page=workflowTreeDiscoveryPage({candidates:[{rootId,definitionHash,policyHash,version:1,status:'running'}],examined:1,nextCursor:{format:1,scope,policyHash,afterId:rootId}},command as never);expect(page.candidates[0]).toMatchObject({rootId,definitionHash,status:'running'});expect(Object.isFrozen(page)).toBe(true);});
  it('rejects cross-context, unordered and excess metadata',()=>{expect(()=>workflowTreeDiscoveryCommand('scan',{scope,policyHash,cursor:{format:1,scope,policyHash:hash('e'),afterId:rootId},limit:1})).toThrow();const context={scope,policyHash,cursor:null,limit:2};expect(()=>workflowTreeDiscoveryPage({candidates:[{rootId,definitionHash,policyHash,version:1,status:'running'},{rootId,definitionHash,policyHash,version:2,status:'waiting'}],examined:2,nextCursor:{format:1,scope,policyHash,afterId:rootId}},context)).toThrow();expect(()=>workflowTreeDiscoveryPage({candidates:[],examined:0,nextCursor:{format:1,scope,policyHash,afterId:rootId}},context)).toThrow();expect(()=>workflowTreeDiscoveryPage({candidates:[],examined:0,nextCursor:null,extra:true},context)).toThrow();});
});
