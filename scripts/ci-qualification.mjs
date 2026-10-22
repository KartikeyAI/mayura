import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUALIFICATION_LANES = Object.freeze(['checks', 'consumers', 'tests', 'bundle', 'postgres', 'runtimes', 'container']);

/** A skipped, missing or cancelled lane must never make the release workflow eligible to publish. */
export function assertQualification(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)
    || JSON.stringify(Object.keys(needs).sort()) !== JSON.stringify([...QUALIFICATION_LANES].sort())) {
    throw new Error('Qualification requires exactly the configured lanes.');
  }
  for (const lane of QUALIFICATION_LANES) {
    if (needs[lane]?.result !== 'success') throw new Error(`Qualification lane ${lane} did not succeed.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let needs;
    try { needs = JSON.parse(process.env.MAYURA_QUALIFICATION_NEEDS ?? ''); }
    catch { throw new Error('Invalid qualification results JSON.'); }
    assertQualification(needs);
    console.log('Every qualification lane passed.');
  } catch (error) {
    // Never echo needs.outputs: those may contain private data in a future workflow.
    console.error(error.message); process.exitCode = 1;
  }
}
