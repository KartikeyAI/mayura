// Local pause console: a real SQLite lifecycle fleet, fleet control and authenticated loopback API,
// plus a browser UI built from mayura/client-react. Demo only: loopback, one process, in-memory command journal.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { MayuraError } from 'mayura/core';
import { defineAgent } from 'mayura';
import { createSqliteStore } from 'mayura/storage';
import { scriptedModel } from 'mayura/testing';
import { defineTool } from 'mayura/tools';
import { listenAgentServer } from 'mayura/server-node';
import { createWorkflowFleetControl, lifecycleFleetTarget } from 'mayura/workflows';
import { createWorkflowLifecycleHost, defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';

const here = dirname(fileURLToPath(import.meta.url)); const workspace = resolve(here, '../..');
const any = { '~standard': { version: 1, vendor: 'pause-console', validate: value => ({ value }) } };
const scope = { principalId: 'console-operator', projectId: 'pause-console' };
const effectMs = Number(process.env.MAYURA_CONSOLE_EFFECT_MS ?? 4_000);

// Each run performs one slow effect, then waits on an absolute timer: plenty of running and waiting time to operate on.
const draft = defineTool({ id: 'console/draft', version: '1', description: 'Prepare a draft slowly.', input: any, output: any,
  effects: 'none', capabilities: [], costMicros: 0, timeoutMs: 60_000,
  execute: async input => { await new Promise(done => setTimeout(done, effectMs)); return { drafted: input.title }; } });
const publish = defineWorkflowLifecycle({ id: 'console.publish', version: '1', input: any, output: any, nodes: [
  { kind: 'tool', id: 'draft', tool: draft, input: { kind: 'input', path: [] } },
  { kind: 'timer', id: 'publishAt', dependsOn: ['draft'], fireAtMs: { kind: 'input', path: ['publishAt'] } },
], result: { kind: 'step', stepId: 'draft', path: [] } });

const directory = await mkdtemp(join(tmpdir(), 'mayura-pause-console-'));
const store = createSqliteStore({ filename: join(directory, 'console.sqlite') }); await store.initialize();
const fleet = createWorkflowFleetControl({ store, scope });
const host = createWorkflowLifecycleHost({ store, scope, definitions: [publish], permissions: { allow: ['tool:console/draft'] },
  policyVersion: '1', maxCostMicros: 0, intervalMs: 500, maxBackoffMs: 5_000, hold: fleet });
const runtime = host.runtime; const targets = [lifecycleFleetTarget(runtime)]; const runs = [];
for (const [index, delayMs] of [20_000, 90_000, 600_000].entries()) {
  const run = await runtime.submit(publish, { input: { title: `Release note ${index + 1}`, publishAt: Date.now() + delayMs }, idempotencyKey: `console-${index}` });
  runs.push(run.id);
}

const view = snapshot => Object.freeze({ format: 5, definitionId: publish.id, definitionVersion: publish.version, runId: snapshot.id,
  revision: snapshot.version, status: snapshot.status,
  nodes: publish.nodes.map(node => ({ id: node.id, kind: node.kind, dependsOn: [...(node.dependsOn ?? [])] })),
  steps: publish.nodes.map(node => ({ id: node.id, kind: node.kind, status: snapshot.steps[node.id].status })) });
// Demo journal only: a production adapter must journal command IDs durably with the mutation.
const journal = new Map();
const command = async (input, action, operate) => {
  const key = `${action}:${input.commandId}`; if (journal.has(key)) return journal.get(key);
  if (!runs.includes(input.runId)) return { status: 'not_found' };
  const current = await runtime.inspect(input.runId);
  if (current.version !== input.revision) return { status: 'conflict' };
  let result;
  try { result = { status: 'applied', workflow: view(await operate(input.runId, current)) }; }
  catch (error) { if (error instanceof MayuraError && error.code === 'CONFLICT') result = { status: 'conflict' }; else throw error; }
  journal.set(key, result); return result;
};

const output = await mkdtemp(join(tmpdir(), 'mayura-pause-console-ui-'));
await build({ root: here, logLevel: 'warn', configFile: false, build: { outDir: output, emptyOutDir: true, sourcemap: false },
  resolve: { dedupe: ['react', 'react-dom'], alias: {
    'mayura/client-react/components': join(workspace, 'packages/client-react/dist/components.js'),
    'mayura/client-react': join(workspace, 'packages/client-react/dist/index.js'),
  } } });
let api;
const secret = randomBytes(32); const token = secret.toString('hex');
let uiOrigin = 'http://127.0.0.1:0';
const agent = defineAgent({ id: 'console.noop', version: '1', instructions: 'Unused.', input: any, output: any, tools: [],
  model: scriptedModel([{ type: 'final', output: null, usage: { costMicros: 0 } }]) });
const ui = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === '/config.json') { response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ apiOrigin: api.origin, token })); return; }
  const file = resolve(output, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(output)) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(file); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => ui.listen(Number(process.env.MAYURA_CONSOLE_PORT ?? 0), '127.0.0.1', done));
uiOrigin = `http://127.0.0.1:${ui.address().port}`;

api = await listenAgentServer({
  agents: [{ agent, permissions: { allow: [] } }], allowedOrigins: [uiOrigin],
  authenticate: async ({ token: supplied }) => {
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), secret)) return null;
    return { scope, agentIds: ['console.noop'], capabilities: ['workflows:read', 'workflows:control', 'workflows:fleet'], expiresAtMs: Date.now() + 3_600_000 };
  },
  workflowIndex: { list: async ({ after, limit }) => {
    const ids = [...runs].sort().filter(id => after === null || id > after).slice(0, limit);
    const items = await Promise.all(ids.map(async id => { const snapshot = await runtime.inspect(id);
      return { format: 5, definitionId: publish.id, definitionVersion: publish.version, runId: id, revision: snapshot.version, status: snapshot.status }; }));
    return { items, next: ids.length === limit && ids.at(-1) !== [...runs].sort().at(-1) ? ids.at(-1) : null };
  } },
  workflowViews: { inspect: async ({ runId }) => runs.includes(runId) ? view(await runtime.inspect(runId)) : null },
  workflowPauses: { pause: input => command(input, 'pause', id => runtime.pause(id)) },
  // Continuation lifts an operator pause; the host continues the run on its next cycle.
  workflowResumes: { resume: input => command(input, 'resume', (id, current) => current.status === 'paused' ? runtime.resume(id) : current) },
  workflowFleet: {
    inspect: () => fleet.inspect(), hold: () => fleet.hold(), release: () => fleet.release(),
    sweep: async ({ phase, cursor, limit }) => {
      try { return { status: 'applied', sweep: phase === 'pause' ? await fleet.sweepPause(targets, { cursor, limit }) : await fleet.sweepResume(targets, { cursor, limit }) }; }
      catch (error) { if (error instanceof MayuraError && error.code === 'CONFLICT') return { status: 'conflict' }; throw error; }
    },
  },
  limits: { maxRequests: 64, maxWorkflowOperations: 16, requestTimeoutMs: 10_000 },
});

host.start();
console.log(`Mayura pause console: ${uiOrigin}  (API ${api.origin}; press Ctrl+C to stop)`);

const stop = async () => {
  const report = await host.drain({ timeoutMs: 10_000 }); await api.close(); ui.close(); await store.close();
  await rm(directory, { recursive: true, force: true }); await rm(output, { recursive: true, force: true });
  console.log(JSON.stringify({ stopped: true, drain: report })); process.exit(0);
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);
