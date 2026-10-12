---
title: "Vercel Blob files"
description: "Store files in a private Vercel Blob store with @mayurajs/filestorage-vercel-blob: token, preconditions, CDN-bypassing reads, limits and errors."
package: "@mayurajs/filestorage-vercel-blob"
vendor: "Vercel"
logo: "vercel"
website: "https://vercel.com/storage/blob"
area: "files"
---

[Vercel Blob](https://vercel.com/storage/blob) is Vercel's object store. `@mayurajs/filestorage-vercel-blob` plugs a
private Blob store into [`mayura/files`](../guides/files.md), so you get the same `createFileStore` API, limits,
per-tenant views and file tools as with the built-in S3 backend. It talks to the Blob API with `fetch`, sending the
requests `@vercel/blob` 2.8 sends (Blob API version 12) without that package or its dependencies. It runs on every
runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/filestorage-vercel-blob
```

## Credentials

Create a Blob store with **private** access under **Storage** in the [Vercel dashboard](https://vercel.com/dashboard/stores)
and copy its read-write token, `vercel_blob_rw_<store>_<secret>`. The backend writes private blobs only, so it needs a
private store: a public store refuses its writes. Client tokens (`vercel_blob_client_...`) are refused.

The package reads nothing from the environment, where `@vercel/blob` would read the token and the API's address: pass
the token yourself, for example from `BLOB_READ_WRITE_TOKEN`.

## Use it

```ts
import { createFileStore } from 'mayura/files';
import { vercelBlobFiles } from '@mayurajs/filestorage-vercel-blob';

const files = createFileStore(vercelBlobFiles({ token: process.env.BLOB_READ_WRITE_TOKEN ?? '' }), {
  maxFileBytes: 10 * 1024 * 1024,
});

const created = await files.put('exports/orders.csv', new TextEncoder().encode('order,total\n'), {
  contentType: 'text/csv',
  ifNoneMatch: '*',
});
const latest = await files.get('exports/orders.csv');
await files.delete('exports/orders.csv', { ifMatch: latest?.etag ?? created.etag });
```

See [Files](../guides/files.md) for every store method, the store's own options and the file tools.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | required | The store's read-write token (`vercel_blob_rw_...`). The store id is read from it. |
| `apiURL` | `https://vercel.com/api/blob` | Another Blob API address, for tests: https, or http on this machine. |
| `blobURL` | `https://<store>.private.blob.vercel-storage.com` | Another address for reading blobs, for tests: https, or http on this machine. |
| `maxResponseBytes` | 16 MiB | The largest API response read. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Versions and preconditions

A file's `etag` is Vercel Blob's etag. The store's `conditionalWrites` and `conditionalDelete` are both `true`:

- `ifNoneMatch: '*'` writes without permission to overwrite. When the service refuses and the blob is there, the
  write fails with `CONFLICT`.
- `ifMatch` on a write or a delete is sent as Vercel Blob's own `x-if-match`; a stale etag, or a missing blob, is a
  `CONFLICT`. On a read, the etag is compared with the blob's before its bytes are read.
- A write without preconditions replaces the blob. Keys are stored exactly as given, with no random suffix.

Reads go past the CDN cache, so they see the latest version. A read fetches the blob's information, then its bytes,
and checks that both carry the same etag; if the blob changed in between, the read starts again, up to three times.

## Writes, metadata and limits

- The media type is stored and comes back from `get`, `head` and listings.
- Vercel Blob keeps no custom metadata: a write with `metadata` fails with `INVALID_INPUT`.
- Files are as large as the store's `maxFileBytes`, up to 5 GiB, and Vercel Blob's own limits apply. Each file is held
  in memory while it is written or read.
- Ranges are read with an HTTP `Range` request. If the service answers with the whole file instead, the range is taken
  from it, as long as the whole file fits the limit.

## Errors

Failures reach you as a `FileStoreError` (code `STORAGE_UNAVAILABLE`) with a `reason`, mapped from the Blob API's
answers. Its error code is read only to classify a failure; its message never reaches yours.

| Error | When |
| --- | --- |
| `CONFLICT` | A precondition failed: the blob exists for a create-only write, or has another version, or is missing for `ifMatch`. |
| `INVALID_INPUT` | A write with metadata. |
| `reason: 'authentication'` | HTTP 401 or 403, for example a wrong token. |
| `reason: 'rate_limited'` | HTTP 429. |
| `reason: 'timeout'` | HTTP 408, or the call took longer than the store's `timeoutMs`. |
| `reason: 'unavailable'` | HTTP 5xx, the service could not be reached, or the blob kept changing during a read. |
| `reason: 'rejected'` | The service refused the request for another reason. |
| `reason: 'invalid_response'` | The reply was not what the Blob API promises. |
| `LIMIT_EXCEEDED` | A file or range is larger than the limit for the call. |

A token that is not a read-write token, or an http address on another host, fails with `INVALID_CONFIG` when you call
`vercelBlobFiles()`.

## How it is tested

- Unit tests run the [file store conformance suite](../guides/files.md#writing-a-backend) against a fake Blob API and
  blob host: 12 cases pass, and "writes and reads back bytes, media type and metadata" is skipped because Vercel Blob
  keeps no custom metadata.
- A protocol test records the requests `@vercel/blob` 2.8 sends for a put, a head, a list, a conditional replace and a
  conditional delete, and checks that this package sends the same ones.
- Other tests check that metadata is refused, that a create-only write to an existing blob is a `CONFLICT`, that errors
  carry no service text, and that nothing is read from the environment.
- `scripts/live/filestorage-vercel-blob.mjs` runs the suite on a real private store; it has not passed against a real
  account yet.

## Related

- [Files](../guides/files.md): stores, views, preconditions and file tools.
- [Artifacts](../guides/artifacts.md#in-s3-r2-and-other-file-stores): keep agent artifacts in Vercel Blob.
- [Cloudflare R2 files](filestorage-r2.md): another edge file store.
- [Files SDK files](filestorage-files-sdk.md): other providers through Files SDK.
