# @mayurajs/filestorage-files-sdk

Any [Files SDK](https://files-sdk.dev) provider for Mayura's file stores (`mayura/files`): S3, R2, GCS, Azure,
Supabase, Netlify Blobs, Dropbox, OneDrive, Box, SFTP, WebDAV and the rest of its adapters.

```bash
npm install mayura files-sdk @mayurajs/filestorage-files-sdk
```

```ts
import { Files } from 'files-sdk';
import { supabase } from 'files-sdk/supabase';
import { createFileStore } from 'mayura/files';
import { filesSdkFiles } from '@mayurajs/filestorage-files-sdk';

const files = createFileStore(filesSdkFiles({ files: new Files({ adapter: supabase({ /* ... */ }) }) }), { maxFileBytes: 10 * 1024 * 1024 });
```

- The store keeps what the provider can, from the adapter's capabilities: preconditions when it has native
  conditional create, replace and exact reads (and conditional deletes), metadata when it keeps metadata, and ranged
  reads where it has them (otherwise the file is read whole, within the limit). What it cannot keep is refused.
- Files SDK errors map to the store's reasons, without their messages.
- The client is typed by shape: `files-sdk` and its provider packages are yours to install and configure.

See the [files guide](https://mayurajs.com/docs/guides/files/). Apache-2.0.
