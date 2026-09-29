// Build the Mayura server/worker container image from locally packed archives, offline, and optionally
// smoke-test a compose deployment (PostgreSQL, one server, two leader-elected workers).
//   node scripts/server-image.mjs [--smoke] [--node 22|24]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { createPacker } from './local-packages.mjs';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
// Supported Node.js lines, each pinned by digest. `--node 22` qualifies the same closure on the 22 LTS line.
const baseImages = {
  24: 'node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5',
  22: 'node:22.23.2-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85',
};
const nodeLine = process.argv.includes('--node') ? process.argv[process.argv.indexOf('--node') + 1] : '24';
assert(Object.hasOwn(baseImages, nodeLine), `Unsupported --node line: ${nodeLine}`);
const baseImage = baseImages[nodeLine];
const postgresImage = readFileSync(join(workspace, 'compose.test.yaml'), 'utf8').match(/image:\s*(postgres@sha256:[a-f0-9]{64})/)[1];
// What a deployment installs: the published `mayura` package and the one optional peer PostgreSQL deployments need.
const roots = [['mayura', join(workspace, 'packages', 'cli')], ['pg', join(workspace, 'packages', 'storage-postgres')]];
// Reviewed third-party closure: exact versions, no lifecycle scripts. Changes require a dependency review.
const external = {
  hono: '4.13.9', '@hono/node-server': '2.1.1',
  // Schemas: `z` from the root import. MIT, no dependencies and no install scripts.
  zod: '4.6.5',
  // The CLI's interactive prompts (loaded only by `mayura init` in a terminal), all MIT with no install scripts.
  '@clack/prompts': '1.8.1', '@clack/core': '1.5.1', sisteransi: '1.0.5', 'fast-wrap-ansi': '0.2.2', 'fast-string-width': '3.0.2', 'fast-string-truncated-width': '3.0.3',
  pg: '8.23.0', 'pg-connection-string': '2.14.0', 'pg-pool': '3.14.0', 'pg-protocol': '1.16.0', 'pg-types': '2.2.0', 'pg-int8': '1.0.1',
  'postgres-array': '2.0.0', 'postgres-bytea': '1.0.1', 'postgres-date': '1.0.7', 'postgres-interval': '1.2.0', xtend: '4.0.2',
  pgpass: '1.0.5', split2: '4.2.0', 'pg-cloudflare': '1.4.0',
};
const inside = (parent, child) => { const value = relative(parent, child); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
function tool(name, ...suffixes) {
  const directories = [dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)];
  const found = suffixes.flatMap(suffix => directories.flatMap(directory => [join(directory, 'node_modules', suffix), resolve(directory, '..', 'lib', 'node_modules', suffix)])).find(existsSync);
  assert(found, `Could not locate the local ${name} CLI.`); return found;
}
const npm = tool('npm', 'npm/bin/npm-cli.js'); const pnpm = tool('pnpm', 'pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js');
const run = async (command, args, cwd, timeout = 120_000) => {
  try { return await exec(command, args, { cwd, timeout, maxBuffer: 16 * 1_048_576, windowsHide: true,
    env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' } }); }
  catch (error) { throw new Error(`Command failed: ${[command, ...args].join(' ')}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`); }
};
const node = (args, cwd, timeout) => run(process.execPath, args, cwd, timeout);

async function main() {
  const smoke = process.argv.includes('--smoke');
  await mkdir(join(workspace, '.artifacts'), { recursive: true }); // gitignored: absent in a fresh checkout
  const output = await mkdtemp(join(workspace, '.artifacts', 'server-image-')); const tarballs = join(output, 'tarballs'); await mkdir(tarballs);
  // `mayura` is the bundle (scripts/bundle-package.mjs); third-party packages come from the local installation.
  const packer = createPacker({ output, tarballs }); const closure = await packer.packClosure(roots);
  for (const name of closure) {
    if (name === 'mayura') continue; const { manifest } = packer.packages.get(name);
    assert(external[name], `Unreviewed dependency in the server image closure: ${name}`);
    assert.equal(manifest.version, external[name], `Unexpected ${name} version.`);
  }
  const packed = new Map([...closure].map(name => [name, { archive: fileURLToPath(packer.packages.get(name).archive), manifest: packer.packages.get(name).manifest }]));
  // Offline install of exactly the packed closure into the staged application.
  const app = join(output, 'context', 'app'); await mkdir(app, { recursive: true });
  const archive = name => pathToFileURL(packed.get(name).archive).href;
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'mayura-deployment', version: '1.0.0', private: true, type: 'module',
    dependencies: Object.fromEntries(roots.map(([name]) => [name, archive(name)])), overrides: Object.fromEntries([...packed.keys()].map(name => [name, archive(name)])) }, null, 2));
  await writeFile(join(app, '.npmrc'), '');
  await node([npm, 'install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--userconfig', join(app, '.npmrc'), '--cache', join(output, 'npm-cache')], app, 300_000);
  await rm(join(app, '.npmrc')); await rm(join(app, 'package-lock.json'), { force: true });
  await cp(join(workspace, 'examples', 'deployment', 'app.mjs'), join(app, 'app.mjs'));
  for (const name of packed.keys()) assert(inside(await realpath(app), await realpath(join(app, 'node_modules', name))), 'Staged application contains a workspace symlink.');
  const dockerfile = [
    `FROM ${baseImage}`,
    `LABEL org.opencontainers.image.title="Mayura server and worker" org.opencontainers.image.version="1.0.0-rc.1" org.opencontainers.image.licenses="Apache-2.0" \\`,
    `      org.opencontainers.image.base.name="${baseImage}"`,
    'WORKDIR /app', 'COPY --chown=65532:65532 app/ /app/', 'USER 65532:65532', 'ENV NODE_ENV=production', 'EXPOSE 8080 9090',
    'ENTRYPOINT ["node", "/app/node_modules/mayura/lib/cli/dist/bin.js"]', 'CMD ["serve", "--app", "/app/app.mjs"]', ''].join('\n');
  await writeFile(join(output, 'context', 'Dockerfile'), dockerfile);
  const tag = `mayura-server:dev-${output.slice(-6).toLowerCase()}`;
  await run('docker', ['build', '--pull=false', '--network=none', '--tag', tag, join(output, 'context')], workspace, 600_000);
  const report = { status: 'built', image: tag, baseImage, packages: [...packed.entries()].map(([name, value]) => ({ name, version: value.manifest.version })).sort((a, b) => a.name.localeCompare(b.name)) };
  if (smoke) report.smoke = await smokeTest(tag, output);
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await rm(join(output, 'npm-cache'), { recursive: true, force: true });
  console.log(JSON.stringify({ ...report, report: relative(workspace, join(output, 'report.json')) }));
}

async function smokeTest(tag, output) {
  const token = randomBytes(32).toString('hex'); const project = `mayura-smoke-${output.slice(-6).toLowerCase()}`;
  const compose = `name: ${project}
services:
  postgres:
    image: ${postgresImage}
    environment: { POSTGRES_USER: mayura, POSTGRES_PASSWORD: mayura_smoke_only, POSTGRES_DB: mayura }
    tmpfs: [/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U mayura -d mayura"], interval: 2s, timeout: 5s, retries: 30 }
  server:
    image: ${tag}
    command: ["serve", "--app", "/app/app.mjs"]
    environment:
      DATABASE_URL: postgresql://mayura:mayura_smoke_only@postgres:5432/mayura
      MAYURA_PUBLIC_ORIGIN: https://mayura.smoke.test
      MAYURA_API_TOKEN_SHA256: ${createHash('sha256').update(token).digest('hex')}
    ports: ["127.0.0.1::8080"]
    depends_on: { postgres: { condition: service_healthy } }
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"], interval: 2s, timeout: 5s, retries: 30 }
  worker:
    image: ${tag}
    command: ["worker", "--app", "/app/app.mjs", "--probe-host", "0.0.0.0", "--probe-port", "9090", "--drain-timeout-ms", "10000"]
    environment:
      DATABASE_URL: postgresql://mayura:mayura_smoke_only@postgres:5432/mayura
      MAYURA_SEED_DUE_AT_MS: "${Date.now() + 25_000}"
    deploy: { replicas: 2 }
    stop_grace_period: 20s
    depends_on: { postgres: { condition: service_healthy } }
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9090/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"], interval: 2s, timeout: 5s, retries: 30 }
`;
  const file = join(output, 'compose.yaml'); await writeFile(file, compose);
  const composeRun = (...args) => run('docker', ['compose', '-f', file, ...args], output, 300_000);
  const results = {};
  try {
    await composeRun('up', '--detach', '--wait');
    const port = (await composeRun('port', 'server', '8080')).stdout.trim().split(':').pop();
    // node:http, not fetch: fetch silently replaces a caller-supplied Host header, which the production host would refuse.
    const call = (path, init = {}) => new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: Number(port), path, method: 'GET', headers: { host: 'mayura.smoke.test', ...(init.headers ?? {}) } }, response => {
        let body = ''; response.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () => resolve({ status: response.statusCode, body }));
      }); request.on('error', reject); request.end();
    });
    const authorized = { authorization: `Bearer ${token}` };
    results.serverReady = (await call('/readyz')).status === 200;
    results.unauthenticated = (await call('/v1/workflow-fleet')).status === 401;
    results.fleet = JSON.parse((await call('/v1/workflow-fleet', { headers: authorized })).body);
    // The seeded reminder is due 5 s after the first worker starts; only the leader drives it to completion.
    let listed = []; for (let attempt = 0; attempt < 60; attempt++) {
      const page = await call('/v1/workflow-runs?limit=20', { headers: authorized });
      if (page.status !== 200) throw new Error(`Workflow listing failed with ${page.status}: ${page.body.slice(0, 300)}`);
      listed = JSON.parse(page.body).items;
      results.observedWaiting ||= listed.length === 1; if (results.observedWaiting && listed.length === 0) break;
      await new Promise(done => setTimeout(done, 500));
    }
    results.seededRunCompleted = results.observedWaiting === true && listed.length === 0;
    const logs = (await composeRun('logs', '--no-color', 'worker')).stdout;
    results.workersStarted = (logs.match(/"event":"worker-started"/g) ?? []).length;
    await composeRun('stop', '--timeout', '20', 'worker');
    const stoppedLogs = (await composeRun('logs', '--no-color', 'worker')).stdout;
    results.workersDrained = (stoppedLogs.match(/"event":"stopped","drained":true/g) ?? []).length;
    const states = JSON.parse(`[${(await composeRun('ps', '--all', '--format', 'json', 'worker')).stdout.trim().split(/\r?\n/).join(',')}]`);
    results.workerExitCodes = states.map(state => state.ExitCode);
    assert(results.serverReady && results.unauthenticated && results.fleet.fleet.held === false && results.seededRunCompleted
      && results.workersStarted === 2 && results.workersDrained === 2 && results.workerExitCodes.every(code => code === 0), `Smoke test failed: ${JSON.stringify(results)}`);
    return { status: 'passed', ...results };
  } finally { await composeRun('down', '--volumes', '--timeout', '5').catch(() => {}); }
}

await main();
