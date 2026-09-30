# @mayurajs/filestorage-r2

Cloudflare R2 through a Workers binding, for Mayura's file stores (`mayura/files`).

```bash
npm install mayura @mayurajs/filestorage-r2
```

```ts
import { createFileStore } from 'mayura/files';
import { r2Files } from '@mayurajs/filestorage-r2';

export default {
  async fetch(request: Request, env: { FILES: R2Bucket }) {
    const files = createFileStore(r2Files({ bucket: env.FILES }), { maxFileBytes: 10 * 1024 * 1024 });
    // ...
  },
};
```

- No keys, endpoints or signing: the binding is the credential.
- `ifMatch` and `ifNoneMatch` are R2's own preconditions. The binding cannot delete conditionally, so the store's
  `conditionalDelete` is false and a conditional delete is refused.
- Outside Workers, reach R2 over its S3 API with `s3Files` in `mayura/files` (`region: 'auto'`).
- Passes Mayura's file store conformance suite on R2 in Miniflare.

See the [files guide](https://mayurajs.com/docs/guides/files/). Apache-2.0.
