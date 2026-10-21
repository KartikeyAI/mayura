import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
// Local single-user setup only. Secrets go to owner-readable ignored files, never logs or browser bundles.
const token = randomBytes(32).toString('hex');
const sessions = [{ tokenSha256: createHash('sha256').update(token).digest('hex'), principalId: 'local-user', expiresAtMs: Date.now() + 8 * 3600000 }];
await mkdir('.data', { recursive: true });
await writeFile('.env', `MAYURA_PUBLIC_ORIGIN=http://localhost:3000\nMAYURA_PROJECT_ID=notebook\nMAYURA_SESSIONS_JSON='${JSON.stringify(sessions)}'\n`, { flag: 'wx', mode: 0o600 });
await writeFile('.data/login-token', token, { flag: 'wx', mode: 0o600 });
console.log('Local session created. Open .data/login-token and enter it in the notebook. Restart the server after changing identities.');
