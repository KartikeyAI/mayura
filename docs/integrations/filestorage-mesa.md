---
title: "Mesa files"
description: "Store files in a Mesa repository, each write a committed change, with @mayurajs/filestorage-mesa: tokens, rebasing writes, limits and errors."
package: "@mayurajs/filestorage-mesa"
vendor: "Mesa"
logo: "mesa"
website: "https://mesa.dev"
area: "files"
---

[Mesa](https://mesa.dev) is a versioned filesystem for agents: repositories whose history keeps every version of every
file. `@mayurajs/filestorage-mesa` plugs a Mesa repository into [`mayura/files`](../guides/files.md), so you get the
same `createFileStore` API, limits, per-tenant views and file tools as with the built-in S3 backend. Each key is a file
path on a bookmark (a branch), and each write or delete is a change committed on it. It talks to Mesa's REST API with
`fetch`: no Mesa SDK, no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/filestorage-mesa
```

## Credentials

The backend takes a Mesa access token source, a function called before each request. Mesa access tokens are
short-lived JWTs minted from your organization's private key, which you create under **Keys** in your organization's
settings in the [Mesa dashboard](https://app.mesa.dev). The token needs write access (`rw`) to the repository, since the
backend commits changes and moves the bookmark.

The package reads nothing from the environment: keep the key in your secret configuration, for example in
`MESA_API_KEY` with `MESA_ORG` and `MESA_REPO`, and pass a function that returns a current token.

## Use it

```ts
import { createFileStore } from 'mayura/files';
import { mesaFiles, mesaMaxFileBytes } from '@mayurajs/filestorage-mesa';

// A Mesa access token source: a short-lived JWT minted from your private key, for example with Mesa's SDK.
const token = async (): Promise<string> => process.env.MESA_ACCESS_TOKEN ?? '';

const files = createFileStore(mesaFiles({
  token,
  org: process.env.MESA_ORG ?? 'acme',
  repo: process.env.MESA_REPO ?? 'agent-notes',
  author: { name: 'Support agent', email: 'support-agent@acme.example' },
}), { maxFileBytes: mesaMaxFileBytes });

await files.put('tickets/1001.md', new TextEncoder().encode('Refund approved.\n'));
const note = await files.get('tickets/1001.md');
console.log(note?.etag); // the file's git blob SHA
```

`mesaMaxFileBytes` is 128 KB, the most Mesa's REST API takes in one file. See [Files](../guides/files.md) for every store
method, the store's own options and the file tools.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | required | A function returning a Mesa access token, called for each request. |
| `org` | required | The organization: letters, digits, `.`, `_` and `-`, at most 100 characters. |
| `repo` | required | The repository, named the same way. |
| `bookmark` | `main` | The bookmark files are read from and committed to. |
| `author` | `Mayura <mayura@users.noreply.mesa.dev>` | The commit author, `{ name, email }`. |
| `maxRebases` | 5 | How many times a write rebases onto a bookmark another writer moved. |
| `maxFiles` | 10,000 | The most files a listing walks. |
| `apiURL` | `https://api.mesa.dev/v1` | Another API address, for tests: https, or http on this machine. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Commits and concurrency

- A write or delete reads the bookmark's head, creates a change on it with the file, and moves the bookmark forward to
  the change. Writes are commits titled `Write <key>` and `Delete <key>`.
- Mesa moves a bookmark only forward. When another writer moved it first, the write starts again on the new head, up
  to `maxRebases` times, so concurrent writers never lose each other's changes. If it still cannot land, it fails with
  `rate_limited`.
- Every version stays in the repository's history: a delete removes the file from the bookmark, not from history.

## Versions and preconditions

A file's `etag` is its git blob SHA, quoted, so two files with the same bytes have the same etag. Mesa has no per-file
preconditions, so the store's `conditionalWrites` and `conditionalDelete` are both `false`, and `ifMatch` and
`ifNoneMatch` are refused with `INVALID_INPUT`. Because a write never replaces the bookmark backwards, concurrent writes
still both land.

## Writes, metadata and limits

- Files are at most 128 KB. A larger write fails with `LIMIT_EXCEEDED` before anything is sent.
- Mesa keeps no media types or metadata: a write with `metadata` fails with `INVALID_INPUT`, the media type you give is
  not stored, and reads report none.
- A read fetches the whole file, then returns the range asked for.
- A listing walks the repository's directories at the bookmark's head, up to `maxFiles` (beyond that it fails with
  `LIMIT_EXCEEDED`), then sorts by key.

## Errors

Failures reach you as a `FileStoreError` (code `STORAGE_UNAVAILABLE`) with a `reason`, mapped from Mesa's answers.
Nothing Mesa wrote reaches the message.

| Error | When |
| --- | --- |
| `INVALID_INPUT` | A call with `ifMatch` or `ifNoneMatch`, or a write with metadata. |
| `LIMIT_EXCEEDED` | A write over 128 KB, a file or range larger than the limit for the call, or more than `maxFiles` files to list. |
| `reason: 'authentication'` | The token source threw or returned no usable token (nothing is sent), or Mesa answered 401 or 403. |
| `reason: 'rate_limited'` | HTTP 429, or the bookmark kept moving for more than `maxRebases` attempts. |
| `reason: 'rejected'` | Mesa reported the change as conflicted, or refused the request for another reason. |
| `reason: 'timeout'` | HTTP 408, or the call took longer than the store's `timeoutMs`. |
| `reason: 'unavailable'` | HTTP 5xx, or Mesa could not be reached. |
| `reason: 'invalid_response'` | The reply was not what Mesa's API promises. |

A missing token source, a malformed name or author, or an http address on another host fails with `INVALID_CONFIG`
when you call `mesaFiles()`.

## How it is tested

- Unit tests run the [file store conformance suite](../guides/files.md#writing-a-backend) against a fake Mesa API: 9
  cases pass; "writes and reads back bytes, media type and metadata" is skipped because Mesa keeps neither, and the three
  precondition cases are skipped because Mesa has no per-file preconditions.
- Other tests check that a write rebases onto a bookmark another writer moved and both files survive, that metadata and
  files over 128 KB are refused before sending, that errors carry no service text, and that nothing is read from the
  environment.
- It has not been run against a real Mesa account yet.

## Related

- [Files](../guides/files.md): stores, views, preconditions and file tools.
- [AgentFS files](filestorage-agentfs.md): another filesystem for agents.
- [Artifacts](../guides/artifacts.md): content-addressed agent output, which needs a store with preconditions.
- [Permissions](../concepts/permissions.md): the permissions file tools need.
