---
title: "Google Drive files"
description: "Store files in one Google Drive folder, or the app's hidden folder, with @mayurajs/filestorage-google-drive: scopes, limits, trash and errors."
package: "@mayurajs/filestorage-google-drive"
vendor: "Google Drive"
logo: "google-drive"
website: "https://www.google.com/drive/"
area: "files"
---

[Google Drive](https://www.google.com/drive/) is Google's file storage for people and teams.
`@mayurajs/filestorage-google-drive` plugs one Drive folder, or your app's hidden folder, into
[`mayura/files`](../guides/files.md), so you get the same `createFileStore` API, limits, per-tenant views and file tools
as with the built-in S3 backend. Each file is named by its key. It talks to the Drive API v3 with `fetch`: no Google
SDK, no other dependencies, and it runs on every runtime Mayura runs on.

Drive is not an object store: it has no preconditions and does not keep names unique. Use it when files should live in
someone's Drive; for an application's own storage, an object store such as [Google Cloud Storage](filestorage-gcs.md)
keeps more guarantees.

## Install

```bash
npm install mayura @mayurajs/filestorage-google-drive
```

## Credentials

The backend takes an OAuth 2.0 access token source, a function called before each request. Create an OAuth client
under [APIs and services > Credentials](https://console.cloud.google.com/apis/credentials), enable the Drive API, and
get tokens with one of two scopes:

- `https://www.googleapis.com/auth/drive.file`: files this app created, in a folder you name by its id.
- `https://www.googleapis.com/auth/drive.appdata`: the app's hidden folder, `appDataFolder`, which the user does not
  see.

The package reads nothing from the environment: pass the token source and folder yourself, for example from
`GOOGLE_DRIVE_ACCESS_TOKEN` and `GOOGLE_DRIVE_FOLDER_ID`.

## Use it

```ts
import { createFileStore, fileTools } from 'mayura/files';
import { googleDriveFiles } from '@mayurajs/filestorage-google-drive';

// An OAuth access token source with the drive.file or drive.appdata scope.
const token = async (): Promise<string> => process.env.GOOGLE_DRIVE_ACCESS_TOKEN ?? '';

const files = createFileStore(googleDriveFiles({ token, folderId: 'appDataFolder' }), { maxFileBytes: 10 * 1024 * 1024 });

await files.put('notes/2026-10-12.md', new TextEncoder().encode('# Standup\n'), { contentType: 'text/markdown' });
const page = await files.list({ prefix: 'notes/' });
console.log(page.files.map(file => file.key));

// Agent tools over the folder; grant tool:drive.read, tool:drive.list and files:drive:read.
const tools = fileTools(files, { name: 'drive' });
```

See [Files](../guides/files.md) for every store method, the store's own options and the file tools.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | required | A function returning an OAuth access token with the `drive.file` or `drive.appdata` scope, called for each request. |
| `folderId` | required | The folder the files live in: a Drive folder id, or `appDataFolder` for the app's hidden folder. |
| `permanentDelete` | `false` | Delete files outright instead of moving them to the trash, where they can be restored. |
| `maxFolderFiles` | 10,000 | The most files a listing reads from the folder, from 1 to 1,000,000. |
| `endpoint` | `https://www.googleapis.com` | Another endpoint, for tests: an https origin, or an http one on this machine. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Versions and preconditions

A file's `etag` is its Drive version number. The store's `conditionalWrites` and `conditionalDelete` are both
`false`, so `ifMatch` and `ifNoneMatch` are refused with `INVALID_INPUT` rather than ignored.

Drive does not keep names unique. Two writers racing to create one key can leave two files with that name; reads and
writes then use the newest, and a delete removes all of them.

## Writes, metadata and limits

- A write finds the newest file with the key's name and replaces its content, or creates a new file in the folder.
  Each write is a resumable upload: one request for the file's information, one for its bytes.
- The media type is the file's Drive `mimeType`. Metadata is kept as Drive app properties, visible only to your app;
  each entry's key and value together are at most 124 bytes, and a longer one fails with `INVALID_INPUT`. A write
  replaces the previous metadata.
- Drive cannot list by prefix or in key order. A listing reads the whole folder, up to `maxFolderFiles` (beyond that it
  fails with `LIMIT_EXCEEDED`), then filters and sorts by key, so it grows with the folder.
- Deletes move files to the trash, unless `permanentDelete` is set.
- Files are as large as the store's `maxFileBytes`, up to 5 GiB. Each file is held in memory while it is written or
  read. Ranges are read with an HTTP `Range` request.
- Requests set `supportsAllDrives` and `includeItemsFromAllDrives`, which Drive needs for a folder in a shared drive.

## Errors

Failures reach you as a `FileStoreError` (code `STORAGE_UNAVAILABLE`) with a `reason`, mapped from Drive's answers.
Nothing Drive wrote reaches the message.

| Error | When |
| --- | --- |
| `INVALID_INPUT` | A call with `ifMatch` or `ifNoneMatch`, or a metadata entry over 124 bytes. |
| `LIMIT_EXCEEDED` | A file or range is larger than the limit for the call, or the folder holds more than `maxFolderFiles` files to list. |
| `reason: 'authentication'` | The token source threw or returned no usable token (nothing is sent), or Drive answered 401 or 403. |
| `reason: 'rate_limited'` | HTTP 429. |
| `reason: 'timeout'` | HTTP 408, or the call took longer than the store's `timeoutMs`. |
| `reason: 'unavailable'` | HTTP 5xx, or Drive could not be reached. |
| `reason: 'rejected'` | Drive refused the request for another reason. |
| `reason: 'invalid_response'` | The reply was not what the Drive API promises, such as an upload address on another host. |

A missing token source, a malformed folder id or an http endpoint on another host fails with `INVALID_CONFIG` when you
call `googleDriveFiles()`.

## How it is tested

- Unit tests run the [file store conformance suite](../guides/files.md#writing-a-backend) against a fake Drive API: 10
  cases pass, and the three precondition cases ("creates only when absent with ifNoneMatch", "replaces only the version
  given with ifMatch" and "deletes only the version given with ifMatch") are skipped because Drive has no
  preconditions.
- Other tests check that preconditions are refused, that the newest of two same-named files is read and both are
  deleted, that deletes go to the trash unless asked otherwise, that names with quotes are queried safely, that long
  metadata and oversized folders are refused, and that nothing is read from the environment.
- It has not been run against a real Google account yet.

## Related

- [Files](../guides/files.md): stores, views, preconditions and file tools.
- [Google Cloud Storage files](filestorage-gcs.md): an object store with generation preconditions.
- [Files SDK files](filestorage-files-sdk.md): Dropbox, OneDrive, Box and other providers through Files SDK.
- [Permissions](../concepts/permissions.md): the permissions file tools need.
