---
title: "Google Cloud Storage files"
description: "Store files in a Google Cloud Storage bucket with @mayurajs/filestorage-gcs: setup, generation preconditions, options, limits and errors."
package: "@mayurajs/filestorage-gcs"
vendor: "Google Cloud"
logo: "google-cloud"
website: "https://cloud.google.com/storage"
area: "files"
---

[Google Cloud Storage](https://cloud.google.com/storage) is Google Cloud's object store. `@mayurajs/filestorage-gcs`
plugs a bucket into [`mayura/files`](../guides/files.md), so you get the same `createFileStore` API, limits, per-tenant
views and file tools as with the built-in S3 backend. It talks to the Cloud Storage JSON API with `fetch`: no Google SDK,
no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/filestorage-gcs
```

## Credentials

The backend takes an OAuth 2.0 access token source, a function called before each request. A service account is the
usual source: create one under [IAM and admin](https://console.cloud.google.com/iam-admin/serviceaccounts), grant it
the **Storage Object User** role (`roles/storage.objectUser`) on the bucket, which covers creating, reading, listing and
deleting objects, and mint tokens for it with a Cloud Storage scope, for example with `google-auth-library`.

The package reads nothing from the environment, neither `GOOGLE_APPLICATION_CREDENTIALS` nor `STORAGE_EMULATOR_HOST`:
your token source decides. Keep the bucket name in `GCS_BUCKET`, for example.

## Use it

```ts
import { createFileStore, fileTools } from 'mayura/files';
import { gcsFiles } from '@mayurajs/filestorage-gcs';

// An OAuth access token source, such as google-auth-library's () => auth.getAccessToken() (unwrapped to the string).
const token = async (): Promise<string> => process.env.GCS_ACCESS_TOKEN ?? '';

const files = createFileStore(gcsFiles({ bucket: process.env.GCS_BUCKET ?? 'acme-reports', token }), {
  maxFileBytes: 10 * 1024 * 1024,
});

// Create a file only if none has this key, then change it only if nobody else did since.
const created = await files.put('reports/q3.csv', new TextEncoder().encode('order,total\n'), { contentType: 'text/csv', ifNoneMatch: '*' });
await files.put('reports/q3.csv', new TextEncoder().encode('order,total\nord-1001,42.00\n'), { contentType: 'text/csv', ifMatch: created.etag });

// Or give an agent tools over one tenant's files; grant tool:reports.read, tool:reports.list and files:reports:read.
const tools = fileTools(files.within('tenants/acme'), { name: 'reports' });
```

See [Files](../guides/files.md) for every store method, the store's own options (`maxFileBytes`, `maxListLimit`,
`timeoutMs`, `prefix`) and the file tools.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `bucket` | required | The bucket name. |
| `token` | required | A function returning an OAuth access token, called for each request. |
| `userProject` | none | The project billed for requests to a Requester Pays bucket. |
| `endpoint` | `https://storage.googleapis.com` | Another endpoint: an https origin, or an http one on this machine for an emulator. No path, credentials or query. |
| `maxListResponseBytes` | 16 MiB | The largest list response read. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Versions and preconditions

A file's `etag` is its Cloud Storage generation, a number that changes on every write. The store's `conditionalWrites`
and `conditionalDelete` are both `true`:

- `ifNoneMatch: '*'` uploads with `ifGenerationMatch=0`: the write succeeds only if no object has the key.
- `ifMatch` on a write, a read or a delete sends that generation as `ifGenerationMatch`.
- An etag that is not a generation this backend issued fails with `CONFLICT` before anything is sent.

A read fetches the object's information, then downloads exactly that generation, so the bytes and the size, etag and
metadata you get describe one version. If the file is replaced in between, the read starts again, up to three times.

## Writes, metadata and limits

- Each write is one multipart upload: the object's information and its bytes in one request.
- The media type is stored as the object's `contentType`; metadata is stored as Cloud Storage custom metadata and comes
  back from `get` and `head`. Listings return each file's size, etag, media type and time, but not its metadata.
- Files are as large as the store's `maxFileBytes`, up to 5 GiB. Each file is held in memory while it is written or read.
- Ranges are read with an HTTP `Range` request.

## Errors

Failures reach you as a `FileStoreError` (code `STORAGE_UNAVAILABLE`) with a `reason`, mapped from Cloud Storage's
answers. Nothing Cloud Storage wrote reaches the message.

| Error | When |
| --- | --- |
| `CONFLICT` | A precondition failed (HTTP 412), or a conditional read or delete found no such version. |
| `reason: 'authentication'` | The token source threw or returned no usable token (nothing is sent), or Cloud Storage answered 401 or 403. |
| `reason: 'rate_limited'` | HTTP 429. |
| `reason: 'timeout'` | HTTP 408, or the call took longer than the store's `timeoutMs`. |
| `reason: 'unavailable'` | HTTP 5xx, Cloud Storage could not be reached, or the file kept changing during a read. |
| `reason: 'rejected'` | Cloud Storage refused the request for another reason. |
| `reason: 'invalid_response'` | The reply was not what the JSON API promises. |
| `LIMIT_EXCEEDED` | A file or range is larger than the limit for the call. |

Configuration mistakes, such as a bucket name with capitals or an http endpoint on another host, fail with
`INVALID_CONFIG` when you call `gcsFiles()`.

## How it is tested

- Unit tests run the [file store conformance suite](../guides/files.md#writing-a-backend) against a fake JSON API that
  checks authorization, multipart uploads, generations and preconditions: all 13 cases pass. Other tests check the
  requests sent, that a file replaced mid-read is read at one version, that errors carry no service text, and that
  nothing is read from the environment.
- In CI, the suite runs against fake-gcs-server, an independent Cloud Storage emulator: 12 cases pass and "deletes only
  the version given with ifMatch" is skipped, because the emulator ignores `ifGenerationMatch` on deletes.
- It has not been run against a real Google Cloud account yet.

## Related

- [Files](../guides/files.md): stores, views, preconditions and file tools.
- [Artifacts](../guides/artifacts.md#in-s3-r2-and-other-file-stores): keep agent artifacts in this bucket.
- [Google Drive files](filestorage-google-drive.md): files in a Drive folder instead.
- [Azure Blob Storage files](filestorage-azure-blob.md): the same store on Azure.
