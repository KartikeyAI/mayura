---
title: "Files SDK files"
description: "Use any Files SDK provider, such as Supabase, Dropbox, OneDrive, Box, SFTP or WebDAV, as a Mayura file store with @mayurajs/filestorage-files-sdk."
package: "@mayurajs/filestorage-files-sdk"
vendor: "Files SDK"
logo: "files-sdk"
website: "https://files-sdk.dev"
area: "files"
---

[Files SDK](https://files-sdk.dev) is an open-source TypeScript library with one API over many storage providers:
S3-compatible services, Google Cloud Storage, Azure, Supabase, Netlify Blobs, Dropbox, OneDrive, Box, SFTP, WebDAV and
more. `@mayurajs/filestorage-files-sdk` turns a Files SDK client into a [`mayura/files`](../guides/files.md) backend, so
any of those providers gets the same `createFileStore` API, limits, per-tenant views and file tools as the built-in S3
backend.

The package has no dependencies: it calls the client you give it, typed by shape. `files-sdk` and the packages its
adapters need are yours to install and configure; the tests use `files-sdk` 2.6.2. It runs wherever your Files SDK
adapter runs.

## Install

```bash
npm install mayura files-sdk @mayurajs/filestorage-files-sdk
```

Install what your adapter needs as well, for example `@supabase/storage-js` for Supabase.

## Credentials

Each provider has its own credentials, and you give them to its Files SDK adapter. For Supabase, that is your project
URL and a key from the project's **API** settings in the [Supabase dashboard](https://supabase.com/dashboard): the
service role key writes to buckets protected by row-level security.

This package reads nothing from the environment. Some Files SDK adapters fall back to environment variables when an
option is missing (the Supabase adapter reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, among others), so pass
every option explicitly when you want the configuration in one place.

## Use it

```ts
import { Files } from 'files-sdk';
import { supabase } from 'files-sdk/supabase';
import { createFileStore } from 'mayura/files';
import { filesSdkFiles } from '@mayurajs/filestorage-files-sdk';

const client = new Files({
  adapter: supabase({ bucket: 'uploads', url: process.env.SUPABASE_URL ?? '', key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '' }),
});
const files = createFileStore(filesSdkFiles({ files: client }), { maxFileBytes: 10 * 1024 * 1024 });

// What this provider keeps decides which options the store accepts.
console.log(files.conditionalWrites, files.conditionalDelete);
await files.put('invoices/inv-1001.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]), { contentType: 'application/pdf' });
```

See [Files](../guides/files.md) for every store method, the store's own options and the file tools.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `files` | required | A Files SDK client, `new Files({ adapter })`, over any of its providers. |

## What the store keeps

The backend reads the adapter's declared `capabilities` and keeps what the provider can keep. What it cannot keep is
refused rather than ignored:

| Capability | When the provider has it | When it does not |
| --- | --- | --- |
| Conditional writes | `conditional.create`, `conditional.replace` and `conditional.exactRead` all set: `ifNoneMatch: '*'` and `ifMatch` become the adapter's native create and replace conditions, and a conditional read its exact read. `conditionalWrites` is `true`. | `ifMatch` and `ifNoneMatch` are refused with `INVALID_INPUT`. |
| Conditional delete | `conditional.delete`: `delete(key, { ifMatch })` passes the etag to the adapter. | A conditional delete is refused with `INVALID_INPUT`. |
| Metadata | `metadata`: metadata is written and read back. | A write with metadata fails with `INVALID_INPUT`. |
| Ranged reads | `rangeRead`: ranges are read natively. | The whole file is read, within the limit, and the range taken from it. |

A file's `etag` is whatever the provider reports. A provider that lists without etags is asked for each listed file's
information, one `head` per file. A read with a range or `ifMatch` first reads the file's information, then checks that
the bytes it downloads carry the same etag.

Files are as large as the store's `maxFileBytes`, up to 5 GiB, and the provider's own limits apply. Each file is held in
memory while it is written or read.

## Errors

Files SDK errors are mapped to the store's, without their messages:

| Files SDK error | Becomes |
| --- | --- |
| `Conflict` | `CONFLICT`. A conditional replace, read or delete of a missing file is a `CONFLICT` too. |
| `NotFound` | `undefined` from `get` and `head`; a plain delete of a missing file succeeds. |
| `Unauthorized` | `FileStoreError`, `reason: 'authentication'`. |
| `ReadOnly` | `FileStoreError`, `reason: 'rejected'`. |
| `Provider` | `FileStoreError`, `reason: 'unavailable'`, or `'timeout'` when the provider timed out. |
| anything else | `FileStoreError`, `reason: 'unavailable'`. |

A call that runs past the store's `timeoutMs` fails with `reason: 'timeout'`, and one cancelled through its `signal`
with `CANCELLED`. Giving something other than a Files SDK client fails with `INVALID_CONFIG` when you call
`filesSdkFiles()`.

## How it is tested

- Unit tests run the [file store conformance suite](../guides/files.md#writing-a-backend) over Files SDK's own memory
  adapter: 10 cases pass, and the three precondition cases are skipped because that adapter declares no native
  conditional operations.
- Other tests use a fake client to check that preconditions and metadata are kept only where the adapter declares them,
  that conditions reach the adapter and its `Conflict` becomes `CONFLICT`, that a range is cut from the whole file within
  the limit, and that errors carry no provider text.
- In CI, the suite runs through Files SDK's RustFS adapter against a real S3-compatible server (`MAYURA_TEST_S3_URL`):
  every case that does not need preconditions passes, the precondition cases pass or skip as the adapter declares, and
  the store's `conditionalWrites` and `conditionalDelete` match the adapter's capabilities.
- It has not been run against a hosted provider account yet.

## Related

- [Files](../guides/files.md): stores, views, preconditions and file tools.
- [Google Cloud Storage files](filestorage-gcs.md) and [Azure Blob Storage files](filestorage-azure-blob.md): direct
  backends with preconditions.
- [Vercel Blob files](filestorage-vercel-blob.md): Vercel Blob without extra dependencies.
- [Artifacts](../guides/artifacts.md#in-s3-r2-and-other-file-stores): artifacts need a store with conditional writes.
