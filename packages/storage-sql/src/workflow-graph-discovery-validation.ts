import type { JsonObject } from '@mayura/core';
import {
  StorageError, workflowGraphDiscoveryCommand, workflowGraphDiscoveryPage,
  type WorkflowGraphDiscoveryScan, type WorkflowGraphDiscoveryStore,
} from '@mayura/storage-contracts';

/** Own commands before await/IPC and validate every bounded metadata-only adapter response. */
export function workflowGraphDiscoveryFacade(request: (method: keyof WorkflowGraphDiscoveryStore, input: JsonObject) => Promise<unknown>): WorkflowGraphDiscoveryStore {
  return Object.freeze({
    initialize: async () => {
      const result = await request('initialize',workflowGraphDiscoveryCommand('initialize',{}));
      if (result !== undefined) throw new StorageError('STORAGE_UNAVAILABLE','Invalid workflow graph discovery initialization response.');
    },
    scan: async value => {
      const command = workflowGraphDiscoveryCommand('scan',value);
      const result = await request('scan',command);
      try { return workflowGraphDiscoveryPage(result,command as unknown as WorkflowGraphDiscoveryScan); }
      catch { throw new StorageError('STORAGE_UNAVAILABLE','Invalid workflow graph discovery page response.'); }
    },
  } satisfies WorkflowGraphDiscoveryStore);
}
