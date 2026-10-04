// Live check of @mayurajs/sandbox-vercel against Vercel: the sandbox conformance suite, plus network and ports.
// Run after pnpm build: node --env-file=.env.live scripts/live/sandbox-vercel.mjs  (needs VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID)
import { createSandboxes } from '../../packages/mayura/dist/sandbox.js';
import { sandboxConformance } from '../../packages/mayura/dist/sandbox__testing.js';
import { vercelSandboxes } from '../../extensions/sandbox-vercel/dist/index.js';

const token = process.env.VERCEL_TOKEN; const teamId = process.env.VERCEL_TEAM_ID; const projectId = process.env.VERCEL_PROJECT_ID;
if (!token || !projectId) { console.log('VERCEL_TOKEN and VERCEL_PROJECT_ID are not set; nothing run.'); process.exit(2); }
const sandboxes = createSandboxes(vercelSandboxes({ token, projectId, ...(teamId ? { teamId } : {}) }), { maxSandboxes: 2, maxLifetimeMs: 900_000, network: ['none', 'all'] });
const results = [];
try {
  const sandbox = await sandboxes.create({ lifetimeMs: 900_000, env: { LIVE_CHECK: 'yes' } });
  for (const test of sandboxConformance) {
    try { results.push([test.name, await test.run({ sandbox })]); } catch (error) { results.push([test.name, `FAILED: ${error.message}`]); }
  }
  const env = await sandbox.exec(['sh', '-c', 'printf %s "$LIVE_CHECK"']);
  results.push(['sandbox environment', env.stdout === 'yes' ? 'passed' : `FAILED: ${JSON.stringify(env.stdout)}`]);
  const offline = await sandbox.exec(['sh', '-c', 'curl -sS -m 5 -o /dev/null https://example.com && echo reached || echo blocked'], { timeoutMs: 20_000 });
  results.push(['no internet by default', offline.stdout.trim() === 'blocked' ? 'passed' : `FAILED: ${offline.stdout}`]);
  const served = await sandboxes.create({ lifetimeMs: 300_000, network: 'all', ports: [3000] });
  await served.writeFile('index.html', 'hello from vercel');
  await served.exec(['sh', '-c', 'nohup npx --yes http-server -p 3000 . >/dev/null 2>&1 &']);
  let body = '';
  for (let attempt = 0; attempt < 30 && body !== 'hello from vercel'; attempt++) {
    body = await fetch(new URL('index.html', await served.url(3000))).then(response => response.text(), () => '');
    if (body !== 'hello from vercel') await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  results.push(['serves a port', body === 'hello from vercel' ? 'passed' : 'FAILED']);
} finally {
  await sandboxes.close().catch(error => results.push(['close', `FAILED: ${error.message}`]));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'skipped' ? 'SKIP' : 'FAIL'} ${name}${outcome.startsWith?.('FAILED') ? ` (${outcome})` : ''}`);
process.exit(results.some(([, outcome]) => outcome.startsWith?.('FAILED')) ? 1 : 0);
