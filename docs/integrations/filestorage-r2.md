---
title: "Cloudflare R2 files"
description: "Store files in Cloudflare R2 from a Worker through its bucket binding with @mayurajs/filestorage-r2: setup, preconditions, limits and errors."
package: "@mayurajs/filestorage-r2"
vendor: "Cloudflare"
logo: "cloudflare"
website: "https://developers.cloudflare.com/r2/"
area: "files"
---

[Cloudflare R2](https://developers.cloudflare.com/r2/) is Cloudflare's object store. `@mayurajs/filestorage-r2` plugs
an R2 bucket into [`mayura/files`](../guides/files.md) through the bucket binding a Worker receives (`env.FILES`), so
you get the same `createFileStore` API, limits, per-tenant views and file tools as with the built-in S3 backend. It has
no dependencies and calls the binding directly, so it runs inside a Cloudflare Worker, where the binding exists.

Outside Workers, reach R2 over its S3 API with the built-in `s3Files` from `mayura/files`, with `region: 'auto'` and
your account's R2 endpoint; see [S3 and S3-compatible services](../guides/files.md#s3-and-s3-compatible-services).

## Install

```bash
npm install mayura @mayurajs/filestorage-r2
```

## Credentials

The binding is the credential: there are no keys, endpoints or signing. Create a bucket in the
[Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/r2) or with `wrangler r2 bucket create`, then bind it
to your Worker in its Wrangler configuration:

```toml
[[r2_buckets]]
binding = "FILES"
bucket_name = "uploads"
```

The package reads nothing from the environment.

## Use it

```ts
import { createFileStore } from 'mayura/files';
import { r2Files, type R2BucketLike } from '@mayurajs/filestorage-r2';

export default {
  async fetch(request: Request, env: { FILES: R2BucketLike }): Promise<Response> {
    const files = createFileStore(r2Files({ bucket: env.FILES }), { maxFileBytes: 10 * 1024 * 1024 });
    const uploads = files.within('tenants/acme');

    if (request.method === 'PUT') {
      const data = new Uint8Array(await request.arrayBuffer());
      const written = await uploads.put('inbox/report.pdf', data, { contentType: 'application/pdf', ifNoneMatch: '*' });
      return Response.json({ etag: written.etag });
    }
    const file = await uploads.get('inbox/report.pdf');
    if (!file) return new Response(null, { status: 404 });
    return new Response(file.data.slice(), { headers: { 'content-type': file.contentType ?? 'application/octet-stream' } });
  },
};
```

`R2BucketLike` is the part of the binding the backend uses, typed by shape, so you need no Workers types; the Workers
`R2Bucket` fits it. See [Files](../guides/files.md) for every store method, the store's own options and the file tools.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `bucket` | required | The bucket binding from the Worker's environment, such as `env.FILES`. |

## Versions and preconditions

A file's `etag` is R2's HTTP etag, quoted. The store's `conditionalWrites` is `true` and `conditionalDelete` is
`false`:

- `ifNoneMatch: '*'` and `ifMatch` on writes and reads are R2's own `onlyIf` preconditions. R2 answers a failed one
  without the object, which becomes `CONFLICT`.
- The binding cannot delete conditionally, so `delete(key, { ifMatch })` is refused with `INVALID_INPUT` before the
  binding is called. A plain delete works.

## Writes, metadata and limits

- The media type is stored as the object's HTTP `contentType`, and metadata as R2 custom metadata; both come back from
  `get` and `head`.
- Files are as large as the store's `maxFileBytes`, up to 5 GiB. Each file is held in memory while it is written or
  read, inside your Worker's memory limit.
- Ranges are R2 ranged reads. A file over the limit for a read is refused before its body is read.
- The binding takes no cancellation signal: a cancelled or timed-out call stops waiting for it.

## Errors

| Error | When |
| --- | --- |
| `CONFLICT` | A precondition failed: the object exists for a create-only write, or has another version. |
| `INVALID_INPUT` | A delete with `ifMatch`. |
| `LIMIT_EXCEEDED` | A file or range is larger than the limit for the call. |
| `CANCELLED` | The call's `signal` aborted. |
| `FileStoreError`, `reason: 'timeout'` | The call took longer than the store's `timeoutMs`. |
| `FileStoreError`, `reason: 'unavailable'` | The binding failed with a network error, or a ranged read failed for another reason. |
| `FileStoreError`, `reason: 'invalid_response'` | The binding returned something R2 does not, or threw another error. |

Giving something other than a bucket binding fails with `INVALID_CONFIG` when you call `r2Files()`.

## How it is tested

- The [file store conformance suite](../guides/files.md#writing-a-backend) runs on Cloudflare's own R2 implementation,
  locally in Miniflare (workerd), through the same binding a Worker gets: 12 cases pass, and "deletes only the version
  given with ifMatch" is skipped because the backend declares no conditional delete.
- Unit tests check that R2 gets its bare etag, that a failed precondition is a `CONFLICT`, that a conditional delete
  never reaches the binding, that an oversized body is refused before it is read, and that cancellation stops a call.
- It has not been run against a real Cloudflare account yet. `scripts/live/filestorage-r2.mjs` checks R2 through its S3
  API with `s3Files`, not this package.

## Related

- [Files](../guides/files.md): stores, views, preconditions and file tools.
- [Artifacts](../guides/artifacts.md#in-s3-r2-and-other-file-stores): keep agent artifacts in R2.
- [Cloudflare D1 storage](storage-d1.md): Mayura's store from the same Worker.
- [Vercel Blob files](filestorage-vercel-blob.md): another edge file store.
