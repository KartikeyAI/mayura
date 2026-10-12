// Live check of Cloudflare R2 through mayura/files' S3 backend (R2's S3 API): the file store conformance suite on a
// real bucket, emptied afterwards. @mayurajs/filestorage-r2 (the Workers binding) runs only inside a Worker; its tests
// use R2 in Miniflare. Run after pnpm build:
//   node --env-file=.env.live scripts/live/filestorage-r2.mjs  (needs CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)
import { fileChecks, report } from './files-checks.mjs';
const { s3Files } = await import(new URL('../../packages/mayura/dist/files.js', import.meta.url).href);

const { CLOUDFLARE_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket } = process.env;
if (!account || !accessKeyId || !secretAccessKey || !bucket) { console.log('CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY or R2_BUCKET is not set; nothing run.'); process.exit(2); }
report(await fileChecks(s3Files({ bucket, region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } })));
