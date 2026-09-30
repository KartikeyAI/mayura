# @mayurajs/filestorage-gcs

Google Cloud Storage for Mayura's file stores (`mayura/files`), over the Cloud Storage JSON API.

```bash
npm install mayura @mayurajs/filestorage-gcs
```

```ts
import { createFileStore } from 'mayura/files';
import { gcsFiles } from '@mayurajs/filestorage-gcs';

// token: an OAuth access token source, such as google-auth-library's () => auth.getAccessToken().
const files = createFileStore(gcsFiles({ bucket: 'acme-reports', token }), { maxFileBytes: 10 * 1024 * 1024 });
```

- A file's etag is its generation: `ifMatch`, `ifNoneMatch` and conditional deletes are Cloud Storage's own
  generation preconditions.
- Reads fetch the object's information and then that exact generation, so bytes and information always describe one
  version.
- `userProject` bills a Requester Pays bucket; `endpoint` reaches an emulator on this machine.
- No dependencies: requests go through fetch, so it runs on Node, Bun, Deno, Workers and Vercel Edge. Nothing is read
  from the environment.
- Passes Mayura's file store conformance suite.

See the [files guide](https://mayurajs.com/docs/guides/files/). Apache-2.0.
