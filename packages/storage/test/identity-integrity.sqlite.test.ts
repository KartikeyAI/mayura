import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { identityIntegrityConformance } from './identity-integrity-conformance.js';

identityIntegrityConformance('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-identity-'));
  const open = () => createSqliteStore({ filename: join(directory, 'identity.sqlite') });
  return { store: open(), reopen: open, cleanup: async () => {
    const target = resolve(directory);
    if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-identity-`)) throw new Error('Unexpected identity fixture directory.');
    await rm(target, { recursive: true, force: true });
  } };
});
