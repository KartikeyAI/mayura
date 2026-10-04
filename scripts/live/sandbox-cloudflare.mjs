// Live check of @mayurajs/sandbox-cloudflare against a deployed sandbox bridge: the sandbox conformance suite on a real Cloudflare sandbox.
// Run after pnpm build: node --env-file=.env.live scripts/live/sandbox-cloudflare.mjs  (needs CF_SANDBOX_BRIDGE_URL and CF_SANDBOX_API_KEY)
import { createSandboxes } from '../../packages/mayura/dist/sandbox.js';
import { sandboxConformance } from '../../packages/mayura/dist/sandbox__testing.js';
import { cloudflareSandboxes } from '../../extensions/sandbox-cloudflare/dist/index.js';

const bridgeUrl = process.env.CF_SANDBOX_BRIDGE_URL; const apiKey = process.env.CF_SANDBOX_API_KEY;
if (!bridgeUrl || !apiKey) { console.log('CF_SANDBOX_BRIDGE_URL or CF_SANDBOX_API_KEY is not set; nothing run.'); process.exit(2); }
const sandboxes = createSandboxes(cloudflareSandboxes({ bridgeUrl, apiKey }), { maxSandboxes: 1, maxLifetimeMs: 900_000, network: ['all'] });
const results = [];
try {
  const sandbox = await sandboxes.create({ lifetimeMs: 900_000, network: 'all', env: { LIVE_CHECK: 'yes' } });
  for (const test of sandboxConformance) {
    try { results.push([test.name, await test.run({ sandbox })]); } catch (error) { results.push([test.name, `FAILED: ${error.message}`]); }
  }
  const long = await sandbox.exec(['sh', '-c', 'sleep 70; printf %s "$LIVE_CHECK"'], { timeoutMs: 120_000 });
  results.push(['a command longer than one exec', long.exitCode === 0 && long.stdout === 'yes' ? 'passed' : `FAILED: ${JSON.stringify(long)}`]);
} finally {
  await sandboxes.close().catch(error => results.push(['close', `FAILED: ${error.message}`]));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'skipped' ? 'SKIP' : 'FAIL'} ${name}${outcome.startsWith?.('FAILED') ? ` (${outcome})` : ''}`);
process.exit(results.some(([, outcome]) => outcome.startsWith?.('FAILED')) ? 1 : 0);
