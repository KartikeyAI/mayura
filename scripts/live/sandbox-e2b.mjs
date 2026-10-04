// Live check of @mayurajs/sandbox-e2b against E2B: the sandbox conformance suite, plus network and ports.
// Run after pnpm build: node --env-file=.env.live scripts/live/sandbox-e2b.mjs  (needs E2B_API_KEY)
import { createSandboxes } from '../../packages/mayura/dist/sandbox.js';
import { sandboxConformance } from '../../packages/mayura/dist/sandbox__testing.js';
import { e2bSandboxes } from '../../extensions/sandbox-e2b/dist/index.js';

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) { console.log('E2B_API_KEY is not set; nothing run.'); process.exit(2); }
const sandboxes = createSandboxes(e2bSandboxes({ apiKey }), { maxSandboxes: 2, maxLifetimeMs: 900_000, network: ['none', 'all'] });
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
  const served = await sandboxes.create({ lifetimeMs: 300_000, network: 'all', ports: [8080] });
  await served.writeFile('index.html', 'hello from e2b');
  await served.exec(['sh', '-c', 'nohup python3 -m http.server 8080 >/dev/null 2>&1 &']);
  let body = '';
  for (let attempt = 0; attempt < 30 && body !== 'hello from e2b'; attempt++) {
    body = await fetch(new URL('index.html', await served.url(8080))).then(response => response.text(), () => '');
    if (body !== 'hello from e2b') await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  results.push(['serves a port', body === 'hello from e2b' ? 'passed' : 'FAILED']);
} finally {
  await sandboxes.close().catch(error => results.push(['close', `FAILED: ${error.message}`]));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'skipped' ? 'SKIP' : 'FAIL'} ${name}${outcome.startsWith?.('FAILED') ? ` (${outcome})` : ''}`);
process.exit(results.some(([, outcome]) => outcome.startsWith?.('FAILED')) ? 1 : 0);
