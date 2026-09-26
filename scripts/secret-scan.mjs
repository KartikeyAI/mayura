// Scan every Git-tracked file for credential material. Exits non-zero with file/line locations (never the
// matched value) when a finding is not covered by an explicit, reviewed allowance below.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const patterns = [
  // PEM blocks begin a line; detection code that merely names the marker inside a string does not.
  ['private key block', /^\s*-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{32,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live key', /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/],
  ['credentialed URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s@'"`]{8,}@(?!127\.0\.0\.1|localhost|postgres[:/])/i],
];
// Reviewed allowances: path plus finding kind. Test-only material must say so in the file itself.
const allowed = [
  ['packages/server-node/test/fixtures/test-only-localhost.key', 'private key block'],
];
const files = execFileSync('git', ['ls-files', '-z'], { cwd: workspace, encoding: 'utf8', maxBuffer: 64 * 1_048_576 }).split('\0').filter(Boolean);
const findings = [];
for (const file of files) {
  const path = resolve(workspace, file); let size;
  try { size = statSync(path).size; } catch { continue; }
  if (size > 2 * 1_048_576) continue;
  const bytes = readFileSync(path); if (bytes.includes(0)) continue;
  const lines = bytes.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [kind, pattern] of patterns) {
      if (!pattern.test(line)) continue;
      if (allowed.some(([allowedPath, allowedKind]) => allowedPath === file.replace(/\\/g, '/') && allowedKind === kind)) continue;
      findings.push({ file, line: index + 1, kind });
    }
  });
}
if (findings.length > 0) {
  console.error(JSON.stringify({ status: 'failed', findings }, null, 2)); process.exitCode = 1;
} else console.log(JSON.stringify({ status: 'passed', filesScanned: files.length, allowances: allowed.length }));
