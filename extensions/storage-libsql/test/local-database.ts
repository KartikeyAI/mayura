import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// libSQL statements can keep a closed file open until collection. Windows cannot unlink it in the meantime.
const collect: () => void = process.platform === 'win32' ? (setFlagsFromString('--expose_gc'), runInNewContext('gc') as () => void) : () => undefined;
export const url = (filename: string) => `file:${filename.split(sep).join('/')}`;

/** Let native statement finalizers run between bounded Windows-only cleanup attempts. */
export async function cleanupClosedDatabase(cleanup: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    // A collection in the closing call's microtask can still see its native statements.
    if (process.platform === 'win32') { await setImmediate(); collect(); await setImmediate(); }
    try { await cleanup(); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || attempt >= 3 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

/** A fresh database file in its own temporary directory, removed afterwards. */
export async function database(prefix: string): Promise<{ filename: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), `mayura-libsql-${prefix}-`));
  return { filename: join(directory, 'store.db'), cleanup: async () => {
    const target = resolve(directory);
    if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-libsql-${prefix}-`)) throw new Error('Unexpected fixture path.');
    await cleanupClosedDatabase(() => rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  } };
}
