// Live check of @mayurajs/sandbox-e2b-desktop: start the desktop, screenshot, type into a terminal, the live view.
// Run after pnpm build: node --env-file=.env.live scripts/live/sandbox-e2b-desktop.mjs  (needs E2B_API_KEY)
import { writeFileSync } from 'node:fs';
import { createSandboxes } from '../../packages/mayura/dist/sandbox.js';
import { e2bDesktopSandboxes } from '../../extensions/sandbox-e2b-desktop/dist/index.js';

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) { console.log('E2B_API_KEY is not set; nothing run.'); process.exit(2); }
const sandboxes = createSandboxes(e2bDesktopSandboxes({ apiKey, liveView: 'view' }), { maxSandboxes: 1, maxLifetimeMs: 900_000 });
const results = [];
const check = (name, passed, detail = '') => results.push([name, passed ? 'passed' : `FAILED ${detail}`]);
try {
  const computer = await sandboxes.create({ lifetimeMs: 600_000 });
  const desktop = computer.desktop;
  const size = await desktop.size();
  check('screen size', size.width === 1024 && size.height === 768, JSON.stringify(size));
  const shot = await desktop.screenshot();
  writeFileSync(new URL('./e2b-desktop-shot.png', import.meta.url), shot.data);
  check('screenshot', shot.data.byteLength > 1_000, `${shot.data.byteLength} bytes`);
  await computer.exec(['sh', '-c', 'setsid nohup xfce4-terminal >/dev/null 2>&1 &'], { env: { DISPLAY: ':0' } });
  await new Promise(resolve => setTimeout(resolve, 3_000));
  await desktop.type('echo typed-by-mayura > /tmp/typed.txt'); await desktop.key('Enter');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const typed = await computer.readFile('/tmp/typed.txt');
  check('type and key into a terminal', new TextDecoder().decode(typed ?? new Uint8Array()).trim() === 'typed-by-mayura');
  const url = await desktop.viewUrl();
  const page = await fetch(url).then(response => response.status, () => 0);
  check('live view serves noVNC', page === 200, `HTTP ${page}`);
} finally {
  await sandboxes.close().catch(error => results.push(['close', `FAILED ${error.message}`]));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
