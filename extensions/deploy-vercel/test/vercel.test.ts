import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployStep, type DeployTarget } from 'mayura/cli/deploy';
import vercelTarget from '../src/index.js';

const target = vercelTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); delete process.env['CRON_SECRET']; });
async function initialized(vercel: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-vercel-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0', type: 'module' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', targets: { vercel } }));
  await applyDeployFiles(await planDeployFiles(target, root)); return root;
}
/** A stand-in for the compiled serverless module: echoes what each function receives. */
async function stub(root: string): Promise<void> {
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await writeFile(join(root, 'dist', 'src', 'mayura.js'), `export async function handle(request) { return Response.json({ url: request.url, method: request.method, body: await request.text() }); }
export async function advanceWorkflows(budgetMs) { return { advanced: true, budgetMs }; }
export async function migrate() { return { schemaVersion: 1 }; }\n`);
}

describe('@mayurajs/deploy-vercel', () => {
  it('writes vercel.json with the /v1 rewrite, function durations and a cron every minute', async () => {
    const root = await initialized({ apiMaxDuration: 120 });
    expect(JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'))).toEqual({
      rewrites: [{ source: '/v1/:path*', destination: '/api/mayura?path=:path*' }],
      functions: { 'api/mayura.js': { maxDuration: 120 }, 'api/advance-workflows.js': { maxDuration: 60 } },
      crons: [{ path: '/api/advance-workflows', schedule: '* * * * *' }],
    });
    expect(JSON.parse(await readFile(join(await initialized({ cron: false }), 'vercel.json'), 'utf8')).crons).toBeUndefined();
  });

  it('puts the rewritten path back before the API handles it, query and body included', async () => {
    const root = await initialized(); await stub(root);
    const { POST } = await import(pathToFileURL(join(root, 'api/mayura.js')).href) as { POST: (request: Request) => Promise<Response> };
    const response = await POST(new Request('https://refunds.vercel.app/api/mayura?path=runs/abc%2Fdef&wait=1', { method: 'POST', body: '{"input":2}', headers: { 'content-type': 'application/json' } }));
    expect(await response.json()).toEqual({ url: 'https://refunds.vercel.app/v1/runs/abc/def?wait=1', method: 'POST', body: '{"input":2}' });
  });

  it('advances workflows only for a call carrying the project\'s CRON_SECRET, within the function\'s time', async () => {
    const root = await initialized(); await stub(root);
    const { GET } = await import(pathToFileURL(join(root, 'api/advance-workflows.js')).href) as { GET: (request: Request) => Promise<Response> };
    const call = (authorization?: string) => GET(new Request('https://refunds.vercel.app/api/advance-workflows', authorization ? { headers: { authorization } } : {}));
    expect((await call('Bearer anything')).status).toBe(401); // no CRON_SECRET configured: nothing is accepted
    process.env['CRON_SECRET'] = 'cron-secret-value';
    expect((await call()).status).toBe(401); expect((await call('Bearer wrong')).status).toBe(401);
    const accepted = await call('Bearer cron-secret-value');
    expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual({ advanced: true, budgetMs: 40_000 });
  });

  it('migrates from here before deploying to production, and checks the deployment URL', async () => {
    const root = await initialized({ scope: 'acme' });
    const plan = await planDeploy(target, root, { tag: 'v2' });
    expect(plan.steps.map(step => [step.id, step.tool, step.args])).toEqual([
      ['check-login', 'vercel', ['whoami', '--scope', 'acme']], ['build', 'npm', ['run', 'build']], ['migrate', 'node', ['deploy/vercel/migrate.mjs']],
      ['deploy', 'vercel', ['deploy', '--prod', '--yes', '--scope', 'acme']],
    ]);
    expect((await planDeploy(target, await initialized({ production: false }), { tag: 'v2' })).steps[3]!.args).toEqual(['deploy', '--yes']);
    const ran: string[] = [];
    const runner: DeployRunner = async (step: DeployStep) => { ran.push(step.id); return { exitCode: step.id === 'migrate' ? 1 : 0 }; };
    expect((await runDeployPlan(plan, { confirmation: plan.digest, runner })).status).toBe('failed');
    expect(ran).toEqual(['check-login', 'build', 'migrate']);
  });

  it('needs deploy init first, and fails a deploy that does not print its URL', async () => {
    const bare = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-vercel-'))); directories.push(bare);
    await writeFile(join(bare, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0' }));
    await expect(planDeploy(target, bare, { tag: 'v2' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('deploy init --target vercel') });
    const root = await initialized();
    const deployOutput = (output: string): DeployRunner => async step => ({ exitCode: 0, ...(step.output ? { output } : {}) });
    let plan = await planDeploy(target, root, { tag: 'v2' });
    expect((await runDeployPlan(plan, { confirmation: plan.digest, runner: deployOutput('https://refunds-abc123.vercel.app\n') })).status).toBe('succeeded');
    plan = await planDeploy(target, root, { tag: 'v2' });
    expect((await runDeployPlan(plan, { confirmation: plan.digest, runner: deployOutput('Error: The deployment failed\n') })).status).toBe('failed');
  });

  it('runs the migration script against the module', async () => {
    const root = await initialized(); await stub(root);
    const { execFile } = await import('node:child_process');
    const output = await new Promise<string>((done, failed) => execFile(process.execPath, ['deploy/vercel/migrate.mjs'], { cwd: root }, (error, stdout) => error ? failed(error) : done(stdout)));
    expect(JSON.parse(output)).toEqual({ schemaVersion: 1 });
  });

  it.each([
    [{ module: '../x.js' }, /module/u], [{ scope: 'Acme Team' }, /scope/u], [{ production: 'yes' }, /production/u], [{ cron: 1 }, /cron/u],
    [{ apiMaxDuration: 5 }, /apiMaxDuration/u], [{ advanceMaxDuration: 2_000 }, /advanceMaxDuration/u], [{ token: 'x' }, /allows only/u],
  ])('refuses malformed settings (%#)', async (vercel, message) => {
    await expect(initialized(vercel)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
  });
});
