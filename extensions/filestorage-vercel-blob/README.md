# @mayurajs/filestorage-vercel-blob

Vercel Blob for Mayura's file stores (`mayura/files`), over the Blob API with fetch.

```bash
npm install mayura @mayurajs/filestorage-vercel-blob
```

```ts
import { createFileStore } from 'mayura/files';
import { vercelBlobFiles } from '@mayurajs/filestorage-vercel-blob';

const files = createFileStore(vercelBlobFiles({ token: blobReadWriteToken }), { maxFileBytes: 10 * 1024 * 1024 });
```

- Private stores. Reads bypass the CDN cache, so they see the latest version; `ifMatch` guards writes and deletes, and
  `ifNoneMatch` makes a write create-only.
- Requests take the form `@vercel/blob` 2.8 sends (Blob API version 12), without its dependencies and without reading
  the environment, where `@vercel/blob` reads the API's address. Pass the token explicitly.
- Vercel Blob keeps no custom metadata: a write with metadata is refused.
- Passes Mayura's file store conformance suite (except metadata), and a test checks its requests against
  `@vercel/blob`'s own.

See the [files guide](https://mayurajs.com/docs/guides/files/). Apache-2.0.
