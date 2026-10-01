# @mayurajs/filestorage-agentfs

AgentFS, Turso's SQLite-backed filesystem for agents, for Mayura's file stores (`mayura/files`).

```bash
npm install mayura agentfs-sdk @mayurajs/filestorage-agentfs
```

```ts
import { AgentFS } from 'agentfs-sdk';
import { createFileStore } from 'mayura/files';
import { agentFsFiles } from '@mayurajs/filestorage-agentfs';

const agent = await AgentFS.open({ id: 'support-agent' });
const files = createFileStore(agentFsFiles({ fs: agent.fs, singleWriter: true }), { maxFileBytes: 10 * 1024 * 1024 });
```

- Each key is a path under `root` (`/files` by default). A file's etag is the SHA-256 of its content; its media type and
  metadata live in a sidecar file under `<root>.mayura`.
- `singleWriter: true` says this store is the database's only writer (one process, or one Durable Object): writes
  are serialized, and `ifMatch`, `ifNoneMatch` and conditional deletes are kept. Without it they are refused.
- A filesystem cannot hold a file where another key needs a directory (`a` and `a/b`): such a write is refused.
- Works with any AgentFS build (Node, browser, Cloudflare Durable Objects): the filesystem is typed by shape, and
  `agentfs-sdk` is yours to install.

See the [files guide](https://mayurajs.com/docs/guides/files/). Apache-2.0.
