// A check's scratch directory under .artifacts: removed when the check exits successfully, kept after a failure so it
// can be inspected (its path is printed). A new run of the same check first removes directories earlier runs kept, so
// only the latest failure stays. MAYURA_KEEP_ARTIFACTS=1 keeps every directory. Each packed install is hundreds of
// megabytes, so directories kept by every run fill a disk within days.
import { readdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const remove = directory => {
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return true; }
  catch { return false; }
};

export async function workDirectory(prefix) {
  const keep = process.env.MAYURA_KEEP_ARTIFACTS === '1';
  if (!keep) {
    // Directories this check kept before: its prefix and the six characters mkdtemp adds, nothing else.
    const parent = dirname(prefix); const stem = basename(prefix);
    let entries = [];
    try { entries = readdirSync(parent, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.length === stem.length + 6 && entry.name.startsWith(stem) && /^[A-Za-z0-9]{6}$/.test(entry.name.slice(stem.length))) {
        if (!remove(join(parent, entry.name))) process.stderr.write(`Could not remove an earlier work directory: ${join(parent, entry.name)}\n`);
      }
    }
  }
  const directory = await mkdtemp(prefix);
  process.once('exit', code => {
    if (keep || (code ?? process.exitCode ?? 0) !== 0) {
      process.stderr.write(`Kept the check's work directory: ${directory}\n`);
      return;
    }
    if (!remove(directory)) process.stderr.write(`Could not remove the check's work directory: ${directory}\n`);
  });
  return directory;
}
