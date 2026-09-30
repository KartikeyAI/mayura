---
title: "Files"
description: "Store and read files in S3, Cloudflare R2 and other object stores, with versions for safe concurrent writes, per-tenant views and permission-gated file tools for agents."
---

`mayura/files` stores files by key in an object store. A key is a `/`-separated path such as `reports/2026/q3.csv`.
Every file has a version tag, its `etag`, so a write can say "only if this file does not exist yet" or "only if it
has not changed since I read it". S3 and S3-compatible services (Cloudflare R2, MinIO, Backblaze B2 and others) are
built in; other services come as `@mayurajs/filestorage-*` packages.

```ts
import { createFileStore, s3Files } from 'mayura/files';

const files = createFileStore(s3Files({
  bucket: 'acme-reports',
  region: 'us-east-1',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '' },
}), { maxFileBytes: 10 * 1024 * 1024 });

const written = await files.put('reports/q3.csv', new TextEncoder().encode('order,total\nord-1001,42.00\n'), { contentType: 'text/csv' });
const file = await files.get('reports/q3.csv');
console.log(written.etag, file?.size);
```

## Store options

| Option | Notes |
| --- | --- |
| `maxFileBytes` | Required. The largest file written or read, up to 5 GiB. Files are held in memory while they are stored and read. |
| `maxListLimit` | The most files one `list` call returns; 1,000 by default and at most. |
| `timeoutMs` | How long one call may take; 60 seconds by default. |
| `prefix` | Keep every key under this prefix, as `within(prefix)` does. |

## Reading and writing

| Method | Notes |
| --- | --- |
| `put(key, data, options?)` | Writes the bytes. Options: `contentType`, `metadata` (up to 16 short ASCII entries), `ifNoneMatch: '*'`, `ifMatch`, `signal`. Returns the file's information with its new `etag`. |
| `get(key, options?)` | The file with its bytes, or `undefined` when there is none. Options: `range: { offset, length? }`, `ifMatch`, `maxBytes`, `signal`. |
| `head(key)` | The file's size, `etag`, media type and metadata, without the bytes, or `undefined`. |
| `list({ prefix?, cursor?, limit? })` | One page of files in key order, and a `cursor` for the next page when there is one. |
| `delete(key, options?)` | Deletes the file. Deleting a file that is not there succeeds. |
| `within(prefix)` | The same store seen under a prefix. |

A key cannot start or end with `/`, contain empty, `.` or `..` parts, backslashes or control characters, and is at
most 1,024 bytes of UTF-8. Mayura checks every key, size and option before a request is sent, and checks what the
service answers before you see it.

## Safe concurrent writes

Two writers that read a file, change it and write it back can lose one of the changes. Use the version tag:

```ts
import { createFileStore, memoryFiles } from 'mayura/files';

const files = createFileStore(memoryFiles(), { maxFileBytes: 1024 * 1024 });

// Create a file only if no file has this key yet.
await files.put('orders/ord-1001.json', new TextEncoder().encode('{"status":"new"}'), { ifNoneMatch: '*' });

// Change it only if nobody else has changed it since it was read.
const current = await files.get('orders/ord-1001.json');
if (current) {
  await files.put('orders/ord-1001.json', new TextEncoder().encode('{"status":"paid"}'), { ifMatch: current.etag });
}
```

A write whose precondition fails, because the file exists or has another version, fails with `CONFLICT` and changes
nothing. Read the file again and retry, or report the conflict. Not every service can keep these preconditions: a
store's `conditionalWrites` and `conditionalDelete` say whether it can, and a store that cannot refuses `ifMatch` and
`ifNoneMatch` with `INVALID_INPUT` rather than ignore them.

## One store per tenant

`within(prefix)` returns a view in which keys are relative to the prefix and nothing outside it can be read, listed,
written or deleted. Derive the prefix from the caller's verified identity, never from input:

```ts
import { createFileStore, memoryFiles, type FileStore } from 'mayura/files';

const files = createFileStore(memoryFiles(), { maxFileBytes: 1024 * 1024 });
const filesFor = (tenantId: string): FileStore => files.within(`tenants/${tenantId}`);

await filesFor('acme').put('notes.txt', new TextEncoder().encode('Acme only'));
console.log(await filesFor('globex').get('notes.txt')); // undefined
```

## S3 and S3-compatible services

`s3Files` signs requests with AWS Signature Version 4 and sends them with fetch, so it runs on Node, Bun, Deno,
Cloudflare Workers and Vercel Edge without the AWS SDK. Nothing is read from the environment, AWS config files or
instance metadata: give the credentials, or a function that returns fresh ones (for example from your own STS call).

| Option | Notes |
| --- | --- |
| `bucket` | Required. |
| `region` | Required, such as `us-east-1`; `auto` for Cloudflare R2. |
| `credentials` | Required. `{ accessKeyId, secretAccessKey, sessionToken? }`, or a function returning them, called for each request. |
| `endpoint` | Another S3-compatible service, such as `https://<account>.r2.cloudflarestorage.com`: an https origin, or an http one on this machine (`http://127.0.0.1:9000`) for a local server. |
| `addressing` | `virtual` (bucket in the host name) or `path`. Virtual on AWS, path with an `endpoint` or a bucket name containing dots. |
| `conditionalDelete` | Send `ifMatch` on deletes. Off by default: turn it on only for a service that honours If-Match on DeleteObject. |

```ts
import { createFileStore, s3Files } from 'mayura/files';

// Cloudflare R2 over its S3 API.
const r2 = createFileStore(s3Files({
  bucket: 'uploads',
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '' },
}), { maxFileBytes: 50 * 1024 * 1024 });
```

## Other services

Provider packages give `createFileStore` a backend for other services:

| Package | Service | Preconditions |
| --- | --- | --- |
| built in: `s3Files` | S3 and S3-compatible services: Cloudflare R2, Backblaze B2, MinIO, RustFS and others | writes; deletes with `conditionalDelete` where the service honours them |
| `@mayurajs/filestorage-gcs` | Google Cloud Storage, over its JSON API with an OAuth `token` source. A file's etag is its generation. | writes and deletes |
| `@mayurajs/filestorage-azure-blob` | Azure Blob Storage, over its REST API with an account key (Shared Key), a Microsoft Entra ID `token` source or a SAS. | writes and deletes |
| `@mayurajs/filestorage-r2` | Cloudflare R2 through a Workers binding (`env.FILES`): no keys or endpoints. Outside Workers, use `s3Files`. | writes (the binding cannot delete conditionally) |
| `@mayurajs/filestorage-vercel-blob` | A private Vercel Blob store, with its read-write `token`. Reads bypass the CDN cache. No custom metadata. | writes and deletes |

```ts
import { createFileStore } from 'mayura/files';
import { gcsFiles } from '@mayurajs/filestorage-gcs';

const files = createFileStore(gcsFiles({
  bucket: 'acme-reports',
  // An OAuth access token source, such as google-auth-library's () => auth.getAccessToken().
  token: async () => process.env.GCS_ACCESS_TOKEN ?? '',
}), { maxFileBytes: 10 * 1024 * 1024 });
```

## File tools for agents

`fileTools(store, { name })` gives an agent tools over one store: `<name>.read` and `<name>.list`, and with
`write: true` also `<name>.write` and `<name>.delete`. Reading requires the permission `files:<name>:read`; writing and
deleting require `files:<name>:write` and are write effects. Text files come back as text, anything else as base64;
large files are read in parts.

```ts
import { createFileStore, fileTools, memoryFiles } from 'mayura/files';

const files = createFileStore(memoryFiles(), { maxFileBytes: 1024 * 1024 });
const workspace = fileTools(files.within('runs/run-42'), { name: 'workspace', write: true });
// Grant: 'tool:workspace.read', 'tool:workspace.list', 'files:workspace:read',
//        'tool:workspace.write', 'tool:workspace.delete', 'files:workspace:write', 'effect:write'.
console.log(workspace.map(tool => tool.id));
```

| Option | Notes |
| --- | --- |
| `name` | Names the tools and their permissions. |
| `write` | Also make the write and delete tools. Off by default. |
| `overwrite` | Let the write tool replace existing files. Off by default: it only creates new files. |
| `maxReadBytes` | The most bytes one read returns; 256 KiB by default. |
| `maxWriteBytes` | The largest file one write stores; 1 MiB by default. |

Give the tools a view made with `within`, so an agent can only reach the files of its tenant or run.

## Errors

A failed call raises `FileStoreError` (code `STORAGE_UNAVAILABLE`) with a `reason`: `authentication`,
`rate_limited`, `unavailable`, `timeout`, `rejected` or `invalid_response`. Messages are fixed text: nothing the
service wrote reaches them. A failed precondition is `CONFLICT`, a file or range over the limit `LIMIT_EXCEEDED`, and a
call cancelled through its `signal` `CANCELLED`.

## Writing a backend

A backend implements `FileBackend`: `put`, `get`, `head`, `list` and `delete` over already-checked keys, and says
whether it keeps preconditions with `conditionalWrites` and `conditionalDelete`. `memoryFiles()` is a complete
backend for tests. `fileStoreConformance` in `mayura/testing` is the file store contract as test cases; a backend
package runs it against its service or an emulator.

## Related

- [Artifacts](artifacts.md)
- [Storage](storage.md)
- [Permissions](../concepts/permissions.md)
- [Testing](testing.md)
