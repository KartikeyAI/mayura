import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployTarget } from 'mayura/cli/deploy';
import cloudflareTarget from '../src/index.js';

const target = cloudflareTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function initialized(cloudflare: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-cloudflare-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0', type: 'module' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', env: ['OPENAI_API_KEY'], targets: { cloudflare } }));
  await applyDeployFiles(await planDeployFiles(target, root)); return root;
}

describe('@mayurajs/deploy-cloudflare: Containers', () => {
  it('writes wrangler.jsonc with server and worker containers on Durable Objects, and a worker image that runs the workflow worker', async () => {
    const root = await initialized({ maxInstances: 4 });
    expect(JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'))).toMatchObject({
      name: 'refunds', main: 'deploy/cloudflare/worker.js',
      containers: [{ class_name: 'MayuraServer', image: './Dockerfile', max_instances: 4 }, { class_name: 'MayuraWorker', image: './deploy/cloudflare/worker.Dockerfile', max_instances: 1 }],
      durable_objects: { bindings: [{ name: 'SERVER', class_name: 'MayuraServer' }, { name: 'WORKER', class_name: 'MayuraWorker' }] },
      exports: { MayuraServer: { type: 'durable-object', storage: 'sqlite' }, MayuraWorker: { type: 'durable-object', storage: 'sqlite' } }, triggers: { crons: ['* * * * *'] },
    });
    const worker = await readFile(join(root, 'deploy/cloudflare/worker.Dockerfile'), 'utf8');
    expect(worker).toContain('CMD ["worker", "--app", "dist/src/app.js", "--probe-host", "0.0.0.0", "--probe-port", "9090"]'); expect(worker).not.toContain('CMD ["serve"');
    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toContain('CMD ["serve", "--app", "dist/src/app.js"]');
  });

  it('routes /v1 to a server container, passes only listed secrets, and keeps the worker container awake on the cron', async () => {
    const root = await initialized({ maxInstances: 4 });
    const stub = join(root, 'node_modules', '@cloudflare', 'containers'); await mkdir(stub, { recursive: true });
    await writeFile(join(stub, 'package.json'), JSON.stringify({ name: '@cloudflare/containers', type: 'module', exports: './index.js' }));
    await writeFile(join(stub, 'index.js'), `export const calls = [];
export class Container { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
const instance = (binding, key) => ({ fetch: async request => { calls.push([binding.name, key, new URL(request.url).pathname]); return new Response(JSON.stringify(new binding.Class({}, binding.env).envVars)); } });
export async function getRandom(binding, count) { return instance(binding, 'random:' + count); }
export function getContainer(binding, name) { return instance(binding, name); }\n`);
    const worker = await import(pathToFileURL(join(root, 'deploy/cloudflare/worker.js')).href) as Record<string, any>;
    const { calls } = await import(pathToFileURL(join(stub, 'index.js')).href) as { calls: unknown[][] };
    const env: Record<string, unknown> = { DATABASE_URL: 'postgres://db', OPENAI_API_KEY: 'sk-test', UNLISTED_SECRET: 'never' };
    env['SERVER'] = { name: 'SERVER', Class: worker['MayuraServer'], env }; env['WORKER'] = { name: 'WORKER', Class: worker['MayuraWorker'], env };
    const response = await worker['default'].fetch(new Request('https://refunds.example.workers.dev/v1/runs'), env);
    expect(await response.json()).toEqual({ DATABASE_URL: 'postgres://db', OPENAI_API_KEY: 'sk-test', PORT: '8080' });
    expect((await worker['default'].fetch(new Request('https://refunds.example.workers.dev/admin'), env)).status).toBe(404);
    const waits: Promise<unknown>[] = [];
    await worker['default'].scheduled({}, env, { waitUntil: (promise: Promise<unknown>) => waits.push(promise) }); await Promise.all(waits);
    expect(calls).toEqual([['SERVER', 'random:4', '/v1/runs'], ['WORKER', 'workflows', '/readyz']]);
    expect(new worker['MayuraWorker']({}, env).envVars).toEqual({ DATABASE_URL: 'postgres://db', OPENAI_API_KEY: 'sk-test', MAYURA_WORKER_ID: 'cloudflare-worker' });
  });

  it('builds and migrates here before wrangler deploys, and stops when the migration fails', async () => {
    const plan = await planDeploy(target, await initialized(), { tag: 'v2' });
    expect(plan.steps.map(step => [step.id, step.tool, step.args])).toEqual([
      ['check-login', 'wrangler', ['whoami']], ['build', 'npm', ['run', 'build']],
      ['migrate', 'node', ['node_modules/mayura/lib/cli/dist/bin.js', 'migrate', '--app', 'dist/src/app.js']], ['deploy', 'wrangler', ['deploy', '--config', 'wrangler.jsonc']],
    ]);
    const ran: string[] = []; const runner: DeployRunner = async step => { ran.push(step.id); return { exitCode: step.id === 'migrate' ? 1 : 0 }; };
    expect((await runDeployPlan(plan, { confirmation: plan.digest, runner })).status).toBe('failed'); expect(ran).not.toContain('deploy');
  });
});

describe('@mayurajs/deploy-cloudflare: Workers', () => {
  it('writes a Worker that hands requests to the module and advances workflows on the cron', async () => {
    const root = await initialized({ runtime: 'workers', name: 'refunds-edge' });
    expect(JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'))).toEqual({ $schema: 'node_modules/wrangler/config-schema.json', name: 'refunds-edge',
      main: 'deploy/cloudflare/worker.ts', compatibility_date: '2026-09-15', compatibility_flags: ['nodejs_compat'], triggers: { crons: ['* * * * *'] } });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'mayura.js'), `export async function handle(request, env) { return Response.json({ path: new URL(request.url).pathname, binding: env.DB }); }
export async function advanceWorkflows(budgetMs, env) { return { budgetMs, binding: env.DB }; }\n`);
    const { default: worker } = await import(pathToFileURL(join(root, 'deploy/cloudflare/worker.ts')).href) as { default: Record<string, any> };
    expect(await (await worker['fetch'](new Request('https://refunds-edge.example.workers.dev/v1/runs'), { DB: 'd1' })).json()).toEqual({ path: '/v1/runs', binding: 'd1' });
    let advanced: unknown; await worker['scheduled']({}, { DB: 'd1' }, { waitUntil: async (promise: Promise<unknown>) => { advanced = await promise; } });
    await new Promise(done => setTimeout(done, 10)); expect(advanced).toEqual({ budgetMs: 20_000, binding: 'd1' });
    expect((await planDeploy(target, root, { tag: 'v2' })).steps.map(step => step.id)).toEqual(['check-login', 'deploy']);
  });

  it('refuses files from the other runtime, a missing init, and malformed settings', async () => {
    const root = await initialized({ runtime: 'workers' });
    const config = JSON.parse(await readFile(join(root, 'mayura.deploy.json'), 'utf8')); config.targets.cloudflare.runtime = 'containers';
    await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify(config));
    await expect(planDeploy(target, root, { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('other runtime') });
    for (const [cloudflare, message] of [[{ runtime: 'pages' }, /runtime/u], [{ name: 'Refunds_Edge' }, /name/u], [{ maxInstances: 0 }, /maxInstances/u], [{ module: '../x.ts' }, /module/u],
      [{ cron: 'yes' }, /cron/u], [{ token: 'x' }, /allows only/u]] as const) {
      await expect(initialized(cloudflare)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
    }
  });
});
