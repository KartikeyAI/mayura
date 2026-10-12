// Live check of @mayurajs/filestorage-vercel-blob: the file store conformance suite on a real Blob store, emptied
// afterwards. Run after pnpm build:
//   node --env-file=.env.live scripts/live/filestorage-vercel-blob.mjs  (needs BLOB_READ_WRITE_TOKEN)
import { fileChecks, report } from './files-checks.mjs';
const { vercelBlobFiles } = await import(new URL('../../extensions/filestorage-vercel-blob/dist/index.js', import.meta.url).href);

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) { console.log('BLOB_READ_WRITE_TOKEN is not set; nothing run.'); process.exit(2); }
report(await fileChecks(vercelBlobFiles({ token })));
