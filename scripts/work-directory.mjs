// A check's scratch directory under .artifacts: removed when the check exits successfully, kept after a failure so it
// can be inspected (its path is printed). MAYURA_KEEP_ARTIFACTS=1 keeps it either way. Each packed install is hundreds
// of megabytes, so directories kept by every run fill a disk within days.
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';

export async function workDirectory(prefix) {
  const directory = await mkdtemp(prefix);
  process.once('exit', code => {
    if (process.env.MAYURA_KEEP_ARTIFACTS === '1' || (code ?? process.exitCode ?? 0) !== 0) {
      process.stderr.write(`Kept the check's work directory: ${directory}\n`);
      return;
    }
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch { process.stderr.write(`Could not remove the check's work directory: ${directory}\n`); }
  });
  return directory;
}
