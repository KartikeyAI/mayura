# @mayurajs/filestorage-google-drive

Google Drive for Mayura's file stores (`mayura/files`), over the Drive API v3.

```bash
npm install mayura @mayurajs/filestorage-google-drive
```

```ts
import { createFileStore } from 'mayura/files';
import { googleDriveFiles } from '@mayurajs/filestorage-google-drive';

// token: an OAuth access token source with the drive.file or drive.appdata scope.
const files = createFileStore(googleDriveFiles({ token, folderId: 'appDataFolder' }), { maxFileBytes: 10 * 1024 * 1024 });
```

- Files live in one folder (a folder id, or `appDataFolder`), each named by its key.
- Drive has no preconditions and does not keep names unique: `conditionalWrites` and `conditionalDelete` are false, so
  `ifMatch` and `ifNoneMatch` are refused, and two writers racing to create one key can leave two files, of which
  reads take the newest (a delete removes all). A file's etag is its Drive version.
- Drive cannot list by prefix or in key order: a listing reads the folder (up to `maxFolderFiles`) and sorts it.
- Deletes move files to the trash unless `permanentDelete` is set. Metadata is kept as app properties, each at most
  124 bytes.
- No dependencies: requests go through fetch. Nothing is read from the environment.

See the [files guide](https://mayurajs.com/docs/guides/files/). Apache-2.0.
