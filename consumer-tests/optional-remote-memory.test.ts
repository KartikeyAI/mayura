import { createRemoteMemoryBridge, mem0Memory, openViking, supermemory, type RemoteMemoryAdapter } from '@mayura/memory-remote';

declare const canonical: Parameters<typeof createRemoteMemoryBridge>[0]['canonical'];
declare const adapter: RemoteMemoryAdapter;
const bridge = createRemoteMemoryBridge({ canonical, adapter, scope: { principalId: 'principal', projectId: 'project' } });
const namespace: string = bridge.namespace;
mem0Memory({ apiKey: 'explicit' }); supermemory({ apiKey: 'explicit' }); openViking({ endpoint: 'http://127.0.0.1:1933' });
// @ts-expect-error Mem0 never discovers an ambient API key.
mem0Memory({});
// @ts-expect-error OpenViking destinations are explicit.
openViking({});
void namespace;
