# @mayurajs/filestorage-azure-blob

Azure Blob Storage for Mayura's file stores (`mayura/files`), over the Blob REST API.

```bash
npm install mayura @mayurajs/filestorage-azure-blob
```

```ts
import { createFileStore } from 'mayura/files';
import { azureBlobFiles } from '@mayurajs/filestorage-azure-blob';

const files = createFileStore(azureBlobFiles({ account: 'acmestorage', container: 'reports', accountKey }), { maxFileBytes: 10 * 1024 * 1024 });
```

- Credentials: an `accountKey` (Shared Key signing), a Microsoft Entra ID `token` source, or a `sas`. Nothing is read
  from the environment.
- Files are block blobs written in one request. `ifMatch`, `ifNoneMatch` and conditional deletes are Azure's own
  conditional headers.
- Metadata keys are stored under names Azure accepts (`run-id` as `m_run_id`) and read back as written.
- `endpoint` reaches Azurite on this machine (`http://127.0.0.1:10000/devstoreaccount1`) or another cloud.
- No dependencies: requests go through fetch, so it runs on Node, Bun, Deno, Workers and Vercel Edge.
- Passes Mayura's file store conformance suite against Azurite.

See the [files guide](https://mayurajs.com/docs/guides/files/). Apache-2.0.
