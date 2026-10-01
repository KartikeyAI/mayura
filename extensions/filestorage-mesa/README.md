# @mayurajs/filestorage-mesa

[Mesa](https://mesa.dev), a versioned filesystem for agents, for Mayura's file stores (`mayura/files`).

```bash
npm install mayura @mayurajs/filestorage-mesa
```

```ts
import { createFileStore } from 'mayura/files';
import { mesaFiles, mesaMaxFileBytes } from '@mayurajs/filestorage-mesa';

// token: a Mesa access token source (a short-lived JWT minted from your API key).
const files = createFileStore(mesaFiles({ token, org: 'acme', repo: 'agent-notes' }), { maxFileBytes: mesaMaxFileBytes });
```

- Each key is a file path on a bookmark (`main` by default). Every write and delete is a change committed on the
  bookmark's head; when another writer moved the bookmark first, the write is rebased onto it, so concurrent writers
  never lose each other's changes. The history is Mesa's: every version stays in the repository.
- Mesa has no per-file preconditions, media types or metadata: `ifMatch`, `ifNoneMatch` and metadata are refused, and
  reads report no media type. A file's etag is its git blob SHA.
- Files are at most 128 KB (Mesa's REST limit); ranges are read from the whole file.
- No dependencies: requests go through fetch. Nothing is read from the environment.

See the [files guide](https://mayurajs.com/docs/guides/files/). Apache-2.0.
