---
title: "AgentFS files"
description: "Store files in AgentFS, Turso's SQLite-backed filesystem for agents, with @mayurajs/filestorage-agentfs: single-writer preconditions and limits."
package: "@mayurajs/filestorage-agentfs"
vendor: "Turso"
logo: "turso"
website: "https://turso.tech"
area: "files"
---

[AgentFS](https://turso.tech) is Turso's filesystem for agents, kept in a SQLite database. `@mayurajs/filestorage-agentfs` plugs an AgentFS
filesystem into [`mayura/files`](../guides/files.md), so you get the same `createFileStore` API, limits, per-tenant views
and file tools as with the built-in S3 backend. Each key is a path under a root directory.

The package has no dependencies: it calls the filesystem object you give it (`agent.fs`), typed by shape, so any AgentFS
build fits: Node, the browser, or a Cloudflare Durable Object. `agentfs-sdk` is yours to install; the tests use 0.6.4.

## Install

```bash
npm install mayura agentfs-sdk @mayurajs/filestorage-agentfs
```

## Credentials

A local AgentFS database needs no account and no credentials: `AgentFS.open` creates or opens it on disk. The backend
itself takes only the filesystem object and reads nothing from the environment. Name the agent's filesystem with your
own setting, for example `AGENTFS_ID`.

## Use it

```ts
import { AgentFS } from 'agentfs-sdk';
import { createFileStore, fileTools } from 'mayura/files';
import { agentFsFiles, type AgentFsLike } from '@mayurajs/filestorage-agentfs';

const agent = await AgentFS.open({ id: process.env.AGENTFS_ID ?? 'support-agent' });

// This process is the database's only writer, so preconditions are kept.
const files = createFileStore(agentFsFiles({ fs: agent.fs as AgentFsLike, singleWriter: true }), { maxFileBytes: 10 * 1024 * 1024 });

await files.put('plans/today.md', new TextEncoder().encode('- answer ticket 1001\n'), { contentType: 'text/markdown', ifNoneMatch: '*' });

// Give the agent tools over its workspace; grant tool:workspace.read, tool:workspace.list, files:workspace:read,
// tool:workspace.write, tool:workspace.delete, files:workspace:write and effect:write.
const tools = fileTools(files, { name: 'workspace', write: true });
```

`agentfs-sdk` 0.6.4 declares `writeFile` with Node's `Buffer` rather than `Uint8Array`, so TypeScript needs the
`as AgentFsLike` above. See [Files](../guides/files.md) for every store method, the store's own options and the file
tools.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `fs` | required | The AgentFS filesystem: `agent.fs` from `AgentFS.open(...)`, or the Cloudflare Durable Object build's. |
| `root` | `/files` | The absolute directory the files live in, without `.` or `..` parts. Media types and metadata live beside it in `<root>.mayura`. |
| `singleWriter` | `false` | This store is the AgentFS database's only writer (one process, or one Durable Object). Then preconditions are kept. |
| `maxFiles` | 10,000 | The most files a listing walks. |

## Versions and preconditions

A file's `etag` is the SHA-256 of its content, quoted, so two writes of the same bytes have the same etag.

- With `singleWriter: true`, the store's `conditionalWrites` and `conditionalDelete` are `true`. Every write and delete
  over the same filesystem in this process takes its turn, and `ifNoneMatch`, `ifMatch` and conditional deletes are
  checked inside that turn. Five racing create-only writes make exactly one file.
- Without it, both are `false` and `ifMatch` and `ifNoneMatch` are refused with `INVALID_INPUT`, because another writer
  could change a file between the check and the write. Set `singleWriter` only when nothing else writes to the database.

## Writes, metadata and limits

- A key is a path: `reports/q3.csv` is the file `/files/reports/q3.csv`, and its directories are created as needed. A
  filesystem cannot hold a file where another key needs a directory, so `a` and `a/b` cannot both exist: such a write
  fails with `INVALID_INPUT`. A delete removes directories it leaves empty, so the name is free again.
- The media type and metadata are kept in a sidecar JSON file under `<root>.mayura` and come back from `get`, `head` and
  listings.
- A listing walks the directories, up to `maxFiles` (beyond that it fails with `LIMIT_EXCEEDED`), then sorts by key.
- Files are as large as the store's `maxFileBytes`, up to 5 GiB. A read loads the whole file, then returns the range
  asked for.

## Errors

| Error | When |
| --- | --- |
| `CONFLICT` | With `singleWriter`, a precondition failed: the file exists for a create-only write, or has another version. |
| `INVALID_INPUT` | A key collides with a file or directory of another key, or a precondition without `singleWriter`. |
| `LIMIT_EXCEEDED` | A file or range is larger than the limit for the call, or the store holds more than `maxFiles` files to list. |
| `CANCELLED` | The call's `signal` aborted. |
| `FileStoreError`, `reason: 'timeout'` | The call took longer than the store's `timeoutMs`. |
| `FileStoreError`, `reason: 'invalid_response'` | AgentFS failed, or a sidecar file is not what the backend wrote. |

Giving something other than an AgentFS filesystem, or a relative `root`, fails with `INVALID_CONFIG` when you call
`agentFsFiles()`.

## How it is tested

- The [file store conformance suite](../guides/files.md#writing-a-backend) runs on real AgentFS databases (`agentfs-sdk`
  0.6.4, on local files) twice: as the single writer, all 13 cases pass; as one writer of many, 10 pass and the three
  precondition cases are skipped because preconditions are refused.
- Other tests check that colliding keys are refused, that racing create-only writes make exactly one file, that a
  delete frees the directories it empties, and that a relative root is refused.
- It has not been run against a hosted Turso account yet.

## Related

- [Files](../guides/files.md): stores, views, preconditions and file tools.
- [Turso and libSQL storage](storage-libsql.md): Mayura's store on Turso.
- [Mesa files](filestorage-mesa.md): another filesystem for agents, with version history.
- [Sandboxes](../guides/sandboxes.md): run agent commands next to their files.
