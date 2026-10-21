// A check's scratch directory under .artifacts: removed when the check exits successfully, kept after a failure so it
// can be inspected (its path is printed). A new run removes retained directories only after proving their owner
// exited. Active runs and directories without ownership evidence are retained. MAYURA_KEEP_ARTIFACTS=1 keeps every
// directory. Each packed install is hundreds of megabytes, so unlimited retention can fill a disk within days.
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Never reap another running qualification process's scratch directory. Missing or unreadable
// ownership evidence is retained conservatively; only a proven exited owner is eligible.
const ownerFile = '.mayura-check-owner.json';
const exitedOwner = directory => {
  try {
    const owner = JSON.parse(readFileSync(join(directory, ownerFile), 'utf8'));
    if (owner.format !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error?.code === 'ESRCH'; }
  } catch { return false; }
};

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
        if (exitedOwner(join(parent, entry.name)) && !remove(join(parent, entry.name))) process.stderr.write(`Could not remove an earlier work directory: ${join(parent, entry.name)}\n`);
      }
    }
  }
  const directory = await mkdtemp(prefix);
  writeFileSync(join(directory, ownerFile), JSON.stringify({ format: 1, pid: process.pid }), { flag: 'wx' });
  process.once('exit', code => {
    if (keep || (code ?? process.exitCode ?? 0) !== 0) {
      process.stderr.write(`Kept the check's work directory: ${directory}\n`);
      return;
    }
    if (!remove(directory)) process.stderr.write(`Could not remove the check's work directory: ${directory}\n`);
  });
  return directory;
}
