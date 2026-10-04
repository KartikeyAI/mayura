// Live check of @mayurajs/sandbox-fly against Fly.io: the sandbox conformance suite on a real Machine.
// Run after pnpm build: node --env-file=.env.live scripts/live/sandbox-fly.mjs  (needs FLY_API_TOKEN and FLY_APP, an existing app)
import { createSandboxes } from '../../packages/mayura/dist/sandbox.js';
import { sandboxConformance } from '../../packages/mayura/dist/sandbox__testing.js';
import { flySandboxes } from '../../extensions/sandbox-fly/dist/index.js';

const token = process.env.FLY_API_TOKEN; const app = process.env.FLY_APP;
if (!token || !app) { console.log('FLY_API_TOKEN and FLY_APP are not set; nothing run.'); process.exit(2); }
const sandboxes = createSandboxes(flySandboxes({ token, app, image: 'docker.io/library/alpine:3.22' }), { maxSandboxes: 1, maxLifetimeMs: 900_000, network: ['all'] });
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
