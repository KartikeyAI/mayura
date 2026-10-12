import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { conversationConformance } from './conversation-conformance.js';

conversationConformance('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-conversations-'));
  const store = createSqliteStore({ filename: join(directory, 'conversations.sqlite') });
  return {
    store,
    async close() {
      await store.close();
      const target = resolve(directory);
      if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-conversations-`)) throw new Error('Unexpected conversation fixture path.');
      await rm(target, { recursive: true, force: true });
    },
  };
});
