import { describe,expect,it } from 'vitest';
import { workflowTreeDiscoveryFacade } from '../src/workflow-tree-discovery-validation.js';

const scope='a'.repeat(64);const policyHash='b'.repeat(64);const rootId='c'.repeat(64);const definitionHash='d'.repeat(64);
describe('workflow-tree discovery facade',()=>{
  it('captures commands and independently validates replies',async()=>{let seen:unknown;const facade=workflowTreeDiscoveryFacade(async(method,input)=>{seen={method,input};return method==='initialize'?undefined:{candidates:[{rootId,definitionHash,policyHash,version:1,status:'waiting'}],examined:1,nextCursor:null};});await facade.initialize();const page=await facade.scan({scope,policyHash,cursor:null,limit:2});expect(seen).toMatchObject({method:'scan',input:{scope,policyHash,limit:2}});expect(page.candidates[0]?.rootId).toBe(rootId);});
  it('rejects malformed adapter pages as unavailable',async()=>{const facade=workflowTreeDiscoveryFacade(async()=>({candidates:[{rootId,definitionHash,policyHash:'e'.repeat(64),version:1,status:'waiting'}],examined:1,nextCursor:null}));await expect(facade.scan({scope,policyHash,cursor:null,limit:2})).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});});
});
