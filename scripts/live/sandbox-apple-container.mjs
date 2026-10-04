// Live check of @mayurajs/sandbox-apple-container on a Mac (macOS 26, Apple silicon, `container system start` done):
// the sandbox conformance suite on a real Apple container, offline on a host-only network, then online.
// Run from the repository root, after `pnpm build`: node scripts/live/sandbox-apple-container.mjs
// Needs the image on the Mac: container image pull docker.io/library/alpine:3.22 (or set APPLE_CONTAINER_IMAGE).

// Run after pnpm build: the built files are found from there.
const root = new URL('../../', import.meta.url);
const { createSandboxes } = await import(new URL('packages/mayura/dist/sandbox.js', root).href);
const { sandboxConformance } = await import(new URL('packages/mayura/dist/sandbox__testing.js', root).href);
const { appleContainerSandboxes } = await import(new URL('extensions/sandbox-apple-container/dist/index.js', root).href);

const image = process.env.APPLE_CONTAINER_IMAGE ?? 'docker.io/library/alpine:3.22';
const sandboxes = createSandboxes(appleContainerSandboxes({ image, hostOnlyNetwork: 'mayura-live-offline', cpus: 1, memoryMiB: 512 }),
  { maxSandboxes: 2, maxLifetimeMs: 900_000, network: ['none', 'all'] });
const results = [];
try {
  const offline = await sandboxes.create({ lifetimeMs: 900_000, env: { LIVE_CHECK: 'yes' } });
  for (const test of sandboxConformance) {
    try { results.push([test.name, await test.run({ sandbox: offline })]); } catch (error) { results.push([test.name, `FAILED: ${error.message}`]); }
  }
  const away = await offline.exec(['sh', '-c', 'wget -q -T 5 -O /dev/null http://1.1.1.1/ && echo reached || echo offline']);
  results.push(['offline on the host-only network', away.stdout === 'offline\n' ? 'passed' : `FAILED: ${JSON.stringify(away)}`]);
  const online = await sandboxes.create({ lifetimeMs: 300_000, network: 'all' });
  const reached = await online.exec(['sh', '-c', 'wget -q -T 10 -O /dev/null http://1.1.1.1/ && echo reached || echo offline']);
  results.push(['online with all', reached.stdout === 'reached\n' ? 'passed' : `FAILED: ${JSON.stringify(reached)}`]);
  await online.release(); await online.release().catch(error => results.push(['released twice', `FAILED: ${error.message}`]));
} finally {
  await sandboxes.close().catch(error => results.push(['close', `FAILED: ${error.message}`]));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'skipped' ? 'SKIP' : 'FAIL'} ${name}${outcome.startsWith?.('FAILED') ? ` (${outcome})` : ''}`);
console.log('Afterwards: container network delete mayura-live-offline');
process.exit(results.some(([, outcome]) => outcome.startsWith?.('FAILED')) ? 1 : 0);
