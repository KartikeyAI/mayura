import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUALIFICATION_LANES = Object.freeze(['checks', 'consumers', 'tests', 'bundle', 'postgres', 'runtimes', 'container']);
const REQUIRED_JOBS = ['scope', 'website', ...QUALIFICATION_LANES].sort();

/** The protected check requires every lane prescribed by the change scope to succeed. */
export function assertQualification(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)
    || JSON.stringify(Object.keys(needs).sort()) !== JSON.stringify(REQUIRED_JOBS)) {
    throw new Error('Qualification requires exactly the configured jobs.');
  }
  if (needs.scope?.result !== 'success') throw new Error('Change scope detection did not succeed.');
  const { scope, website, website_docs: websiteDocs } = needs.scope.outputs ?? {};
  if (!['full', 'website'].includes(scope) || !['true', 'false'].includes(website)
    || !['true', 'false'].includes(websiteDocs) || ((scope === 'website' || websiteDocs === 'true') && website !== 'true')) {
    throw new Error('Invalid change scope outputs.');
  }
  const websiteResult = website === 'true' ? 'success' : 'skipped';
  if (needs.website?.result !== websiteResult) throw new Error(`Website checks must report ${websiteResult}.`);

  const laneResult = scope === 'website' ? 'skipped' : 'success';
  for (const lane of QUALIFICATION_LANES) {
    if (needs[lane]?.result !== laneResult) throw new Error(`Qualification lane ${lane} must report ${laneResult}.`);
  }
  return scope;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let needs;
    try { needs = JSON.parse(process.env.MAYURA_QUALIFICATION_NEEDS ?? ''); }
    catch { throw new Error('Invalid qualification results JSON.'); }
    const scope = assertQualification(needs);
    console.log(scope === 'website' ? 'Website-only qualification passed.' : 'Full framework qualification passed.');
  } catch (error) {
    // Never echo needs.outputs: those may contain private data in a future workflow.
    console.error(error.message); process.exitCode = 1;
  }
}
