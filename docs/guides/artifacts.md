---
title: "Artifacts"
description: "Store files your agents produce on local disk or in S3, R2 and other file stores, with verified content, per-tenant isolation, safe downloads, audits and backups."
---

Agents and workflows often produce files: a generated report, an exported CSV, an image. `mayura/artifacts` stores
such files on the local filesystem, or in any [file store](files.md) such as S3 or Cloudflare R2. Each file is addressed by its SHA-256 digest, kept apart per tenant, checked again
every time it is read, and handed out only as a download under a policy you choose. You get back a small JSON
reference, which you save next to your own records.

```ts
import { createLocalArtifactStore } from 'mayura/artifacts';

const artifacts = createLocalArtifactStore({
  rootDirectory: '/var/lib/my-app/artifacts',
  maxArtifactBytes: 10 * 1024 * 1024,
});
const scope = { principalId: 'acme', projectId: 'reports' };

const staged = await artifacts.stage({
  scope,
  content: new TextEncoder().encode('order,total\nord-1001,42.00\n'),
  mediaType: 'text/csv',
  classification: 'internal',
  filename: 'orders.csv',
});
const reference = await artifacts.commit(staged);
// Save `reference` (plain JSON) with your own record, for example the workflow run that produced it.

const bytes = await artifacts.read(reference, scope);
```

## In S3, R2 and other file stores

`createArtifactStore` keeps artifacts in a [file store](files.md) instead of on local disk, with the same methods, the
same references and the same checks. It runs wherever the file store does, edge runtimes included, and is also
available as `mayura/artifacts/files`, which does not load the local store.

```ts
import { createArtifactStore } from 'mayura/artifacts/files';
import { createFileStore, s3Files } from 'mayura/files';

const files = createFileStore(s3Files({
  bucket: 'acme-artifacts',
  region: 'us-east-1',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '' },
}), { maxFileBytes: 64 * 1024 * 1024 });

const artifacts = createArtifactStore({ files: files.within('artifacts'), maxArtifactBytes: 10 * 1024 * 1024 });
```

Give it a view of its own: it writes `staging/` and `objects/` under the view and reports anything else there as an
anomaly. The file store must keep preconditions (`conditionalWrites`), which commits and restores use to create each
object only once. References are the same in both stores, so a backup from one restores into the other. Reconciliation
uses each file's `etag` to skip files changed after planning; staging cleanup needs a store that reports when files
were written. Limits on staged and committed artifacts are checked by each process, not across processes.

## Store options

| Option | Default | Notes |
| --- | --- | --- |
| `rootDirectory` | required | An absolute path. Mayura creates its staging and object folders inside it. |
| `maxArtifactBytes` | required | Largest file accepted, up to 64 MiB. Files are held in memory while stored. |
| `maxStagedArtifacts` | 128 | Staged files not yet committed or discarded, up to 4,096. |
| `maxCommittedArtifactsPerScope` | 4,096 | Committed files per scope, up to 65,536. |

## Stage, commit, discard

Storing is two steps. `stage` writes the bytes to a private staging area and computes their digest. `commit` checks the
staged file again and moves it into place atomically, returning the reference. If you decide not to keep a staged file,
call `discard(staged)`.

A stage takes:

| Field | Notes |
| --- | --- |
| `scope` | `{ principalId, projectId? }`. Files are partitioned by scope, even when two tenants store identical bytes. |
| `content` | A `Uint8Array`. |
| `mediaType` | A registered media type without parameters, such as `text/csv` or `application/pdf`. |
| `classification` | `public`, `internal`, `confidential` or `restricted`. Downloads are allowed per classification. |
| `filename` | Optional name used for downloads. |
| `expiresAt` | Optional future Unix time in milliseconds. After it, reads fail with `NOT_FOUND`. |

Committing the same bytes with the same metadata in the same scope returns the same reference. References are frozen
JSON objects that bind the scope, digest, size, media type, classification, filename and expiry together; changing any
field makes the reference invalid.

## Read and download

`read(reference, scope)` returns the bytes after checking that the reference is intact, the scope matches, the file
exists, and its size and digest still match. A tampered or missing file fails with an integrity error and returns
nothing. A reference for another scope fails with `PERMISSION_DENIED`.

`disclose` prepares a download for an HTTP response:

```ts
const download = await artifacts.disclose(reference, scope, {
  classifications: ['public', 'internal'],
  maxBytes: 5 * 1024 * 1024,
  mediaTypes: ['text/csv', 'application/pdf'],
});
// download.body is the bytes; download.headers has Content-Type, Content-Length,
// Content-Disposition: attachment, and X-Content-Type-Options: nosniff.
```

A disclosure is always an attachment, never rendered inline. HTML, SVG and XML types are refused even when their
classification is allowed, so a stored file cannot run script in your site. `mediaTypes` narrows the allowed types
further.

## Delete, clean up and audit

- `delete(reference, scope)` removes one committed file.
- `reconcileStaging({ olderThan, maxDeletes })` removes staged files older than a cutoff, left behind when a process
  stopped between `stage` and `commit`. Run it at startup or on a timer.
- `audit(references, scope, { maxTotalBytes })` checks a list of references and reports each as `ok`, `missing`,
  `expired` or `integrity_failed`, without returning content.
- `planReconciliation` and `applyReconciliation` delete committed files that your records no longer reference. You pass
  the complete set of references you keep for the scope, an age cutoff and limits; the plan lists candidates, and
  applying it rechecks each file and skips any that changed. A plan can be applied once, by the store that made it.

## Back up and restore

`backup({ scope, references, authoritativeSetComplete: true, maxTotalBytes })` returns one archive (bytes) for a whole
scope, with an integrity digest over its contents.
`restore(archive, scope, { maxArchiveBytes, maxTotalBytes, maxArtifacts })` installs the files into a store that is
empty or already holds an exact subset of the archive, so an interrupted restore can simply be retried. Run `audit` after a restore, before reopening access.

An archive holds at most 256 files and 64 MiB of content. It is not encrypted: store it somewhere protected, and keep
it together with the database backup that holds your references, because restoring files alone does not restore the
records that point at them.

## Good to know

- Holding a reference is not permission to read the file. Authenticate the caller, derive the scope from their
  verified identity, and check they may see the record the artifact belongs to.
- The local store is local to one host; use `createArtifactStore` over a file store to share artifacts between hosts.
  Neither store scans for malware, encrypts files or schedules backups.
- Your database and the artifact folder are not updated in one transaction. Keep references in your records, and use
  `reconcileStaging` and the reconciliation plan to clean up after crashes.
- To download from a remote source into any staging sink with a size limit and digest check, see `transferArtifact` in
  [helpers](helpers.md).

## Related

- [Storage](storage.md)
- [Durable workflows](durable-workflows.md)
- [Server and client](server-and-client.md)
- [Helpers](helpers.md)
