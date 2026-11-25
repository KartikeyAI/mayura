import { fileURLToPath } from 'node:url';

export default {
  serverExternalPackages: ['better-sqlite3'],
  turbopack: { root: fileURLToPath(new URL('../../', import.meta.url)) },
};
