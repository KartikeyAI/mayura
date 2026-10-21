// Framework-specific qualification owned by test:starters. This module is authored, not executed, during deferred development.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { cli, environment, installedDirectory, run, workspace } from './local-packages.mjs';

export const isFramework = manifest => manifest.mayuraStarter?.kind === 'framework';
export async function buildFramework(directory) {
  const env = { NEXT_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1' };
  await run([cli('npm'), 'run', 'build'], directory, { timeout: 300000, env });
  await run([cli('npm'), 'run', 'typecheck'], directory, { timeout: 180000, env });
}
export const frameworkTests = directory => run(['--test', '--test-reporter=dot', 'test/*.test.mjs'], directory, { timeout: 180000 });
const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
async function binary(name, directory) { const folder = installedDirectory(name, directory); const manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')); const entry = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin)[0]; return join(folder, entry); }
/** Boot the actual framework's compiled route and a separate worker, without an external provider or database. */
export async function bootFramework(starter, directory) {
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`; const token = randomBytes(32).toString('hex');
  const data = join(workspace, '.artifacts', 'framework-starters'); await mkdir(data, { recursive: true });
  const env = environment({ PORT: String(port), HOST: '127.0.0.1', NITRO_PORT: String(port), NITRO_HOST: '127.0.0.1', ORIGIN: origin,
    MAYURA_PUBLIC_ORIGIN: origin, MAYURA_PROJECT_ID: 'framework-fixture', MAYURA_SQLITE_PATH: join(data, `${starter}-${randomBytes(8).toString('hex')}.sqlite`),
    MAYURA_SESSIONS_JSON: JSON.stringify([{ tokenSha256: createHash('sha256').update(token).digest('hex'), principalId: 'fixture', expiresAtMs: Date.now() + 3600000 }]), NEXT_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1' });
  const command = starter === 'nextjs' ? [await binary('next', directory), 'start', '--hostname', '127.0.0.1', '--port', String(port)]
    : starter === 'react-router' ? [await binary('@react-router/serve', directory), './build/server/index.js']
    : [join(directory, starter === 'hono' ? 'server/hono-node.mjs' : starter === 'sveltekit' ? 'build/index.js' : '.output/server/index.mjs')];
  const children = []; let output = '';
  const start = args => { const child = spawn(process.execPath, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); children.push(child); child.stdout.on('data', data => { output = (output + data).slice(-4000); }); child.stderr.on('data', data => { output = (output + data).slice(-4000); }); child.on('error', () => {}); return child; };
  const call = async (path, method = 'GET', body, key) => fetch(`${origin}/api/mayura${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  try {
    const web = start(command); const worker = start([join(directory, 'server/worker.mjs')]);
    const deadline = Date.now() + 60000; let agents; let lastStatus;
    while (Date.now() < deadline) {
      assert(web.exitCode === null && worker.exitCode === null, `Framework process exited: ${output}`);
      try { const response = await call('/v1/agents'); lastStatus = response.status; if (response.ok) { agents = await response.json(); break; } } catch { /* Wait for the local framework listener only. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(agents?.agents?.some(agent => agent.id === 'notebook.assistant'), `Framework did not mount the scoped server (last HTTP status ${lastStatus}): ${output}`);
    let response = await call('/v1/threads', 'POST', { id: 'framework-thread', agentId: 'notebook.assistant' }); assert.equal(response.status, 201);
    response = await call('/v1/runs', 'POST', { agentId: 'notebook.assistant', threadId: 'framework-thread', input: { message: 'A framework note.' } }, 'framework-turn'); assert.equal(response.status, 202); const { id } = await response.json();
    const snapshot = await (await call(`/v1/runs/${id}`)).json(); assert.equal(snapshot.status, 'waiting'); assert.ok(snapshot.approval);
    response = await call(`/v1/runs/${id}/approvals`, 'POST', { callId: snapshot.approval.callId, digest: snapshot.approval.digest, decision: 'approved' }); assert(response.ok);
    const result = await (await call(`/v1/runs/${id}`)).json(); assert.equal(result.status, 'succeeded');
    return { routing: 'mounted', approval: 'completed', worker: 'started' };
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null) { resolve(); return; } const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); })));
  }
}
