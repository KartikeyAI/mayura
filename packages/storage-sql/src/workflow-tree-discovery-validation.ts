import type { JsonObject } from '@mayura/core';
import {
  StorageError,workflowTreeDiscoveryCommand,workflowTreeDiscoveryPage,
  type WorkflowTreeDiscoveryScan,type WorkflowTreeDiscoveryStore,
} from '@mayura/storage-contracts';

/** Own every command before transport and independently validate adapter replies. */
export function workflowTreeDiscoveryFacade(request:(method:keyof WorkflowTreeDiscoveryStore,input:JsonObject)=>Promise<unknown>):WorkflowTreeDiscoveryStore{
  return Object.freeze({
    initialize:async()=>{const result=await request('initialize',workflowTreeDiscoveryCommand('initialize',{}));if(result!==undefined)throw new StorageError('STORAGE_UNAVAILABLE','Invalid workflow-tree discovery initialization response.');},
    scan:async value=>{const command=workflowTreeDiscoveryCommand('scan',value);const result=await request('scan',command);try{return workflowTreeDiscoveryPage(result,command as unknown as WorkflowTreeDiscoveryScan);}catch{throw new StorageError('STORAGE_UNAVAILABLE','Invalid workflow-tree discovery page response.');}},
  } satisfies WorkflowTreeDiscoveryStore);
}
