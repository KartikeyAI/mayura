// Live check of @mayurajs/storage-mongodb on MongoDB Atlas (or any replica set). Run after pnpm build:
//   node --env-file=.env.live scripts/live/storage-mongodb.mjs  (needs MONGODB_URL; MONGODB_DATABASE, default mayura_live)
import { report, storageChecks } from './storage-checks.mjs';
const { createMongoStore } = await import(new URL('../../extensions/storage-mongodb/dist/index.js', import.meta.url).href);

const uri = process.env.MONGODB_URL;
if (!uri) { console.log('MONGODB_URL is not set; nothing run.'); process.exit(2); }
report(await storageChecks(createMongoStore({ uri, database: process.env.MONGODB_DATABASE || 'mayura_live' })));
