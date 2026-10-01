import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployStep, type DeployTarget } from 'mayura/cli/deploy';
import agentCoreTarget from '../src/index.js';

const target = agentCoreTarget as unknown as DeployTarget;
const directories: string[] = []; const servers: ChildProcess[] = [];
afterEach(async () => {
  // A server's directory can only be removed once the process has exited (Windows keeps its working directory open).
  for (const child of servers.splice(0)) if (child.exitCode === null) await new Promise(done => { child.once('exit', done); child.kill(); });
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 5 });
});
const image = '123456789012.dkr.ecr.us-east-1.amazonaws.com/refunds-agent';
const runtime = { region: 'us-east-1', agentRuntimeId: 'refunds_agent-A1B2C3D4E5', roleArn: 'arn:aws:iam::123456789012:role/refunds-agentcore' };
async function initialized(agent: object = runtime, extra: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-agentcore-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0', type: 'module' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', image, targets: { agentcore: agent }, ...extra }));
  await applyDeployFiles(await planDeployFiles(target, root)); return root;
}

/** Starts the generated server against a stub module, on a free port. */
async function serve(root: string): Promise<string> {
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await writeFile(join(root, 'dist', 'src', 'agentcore.js'), `export async function invoke(payload, { sessionId, signal }) {
  if (payload?.fail) throw new Error('SECRET internal detail');
  if (payload?.slow) await new Promise(done => setTimeout(done, 400));
  if (payload?.stream) return new Response('data: {"part":1}\\n\\ndata: {"part":2}\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
  return { answer: payload.question === 'two plus two' ? 4 : null, sessionId, aborted: signal.aborted };
}\n`);
  const child = spawn(process.execPath, ['deploy/agentcore/server.mjs'], { cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] }); servers.push(child);
  const port = await new Promise<string>((done, failed) => { child.stdout!.on('data', (chunk: Buffer) => { const match = /listening on (\d+)/u.exec(chunk.toString()); if (match) done(match[1]!); }); child.on('exit', () => failed(new Error('server exited'))); });
  return `http://127.0.0.1:${port}`;
}
const aws = (script: Record<string, readonly string[]> = {}) => {
  const ran: DeployStep[] = []; const calls = new Map<string, number>();
  const answers: Record<string, readonly string[]> = { 'check-account': ['123456789012'], 'update-runtime': ['UPDATING'], 'runtime-ready': ['UPDATING', 'READY'], ...script };
  const runner: DeployRunner = async step => {
    ran.push(step); const index = calls.get(step.id) ?? 0; calls.set(step.id, index + 1); const list = answers[step.id] ?? [''];
    return { exitCode: 0, ...(step.output ? { output: `${list[Math.min(index, list.length - 1)]}\n` } : {}) };
  };
  return { ran, runner };
};

describe('@mayurajs/deploy-agentcore', () => {
  it('serves AgentCore\'s HTTP contract: /invocations calls invoke(), /ping reports busy while it runs', async () => {
    const url = await serve(await initialized());
    expect(await (await fetch(`${url}/ping`)).json()).toEqual({ status: 'Healthy' });
    const answer = await fetch(`${url}/invocations`, { method: 'POST', body: JSON.stringify({ question: 'two plus two' }), headers: { 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' } });
    expect(answer.status).toBe(200); expect(await answer.json()).toEqual({ answer: 4, sessionId: 'session-123', aborted: false });
    const slow = fetch(`${url}/invocations`, { method: 'POST', body: JSON.stringify({ slow: true }) });
    await new Promise(done => setTimeout(done, 150));
    expect(await (await fetch(`${url}/ping`)).json()).toEqual({ status: 'HealthyBusy' });
    await slow; expect(await (await fetch(`${url}/ping`)).json()).toEqual({ status: 'Healthy' });
    const stream = await fetch(`${url}/invocations`, { method: 'POST', body: JSON.stringify({ stream: true }) });
    expect(stream.headers.get('content-type')).toBe('text/event-stream'); expect(await stream.text()).toBe('data: {"part":1}\n\ndata: {"part":2}\n\n');
  });

  it('answers bad requests and failures without the module\'s error text', async () => {
    const url = await serve(await initialized());
    const failed = await fetch(`${url}/invocations`, { method: 'POST', body: JSON.stringify({ fail: true }) });
    expect(failed.status).toBe(500); const body = await failed.text(); expect(body).not.toContain('SECRET'); expect(JSON.parse(body)).toEqual({ error: 'invocation_failed' });
    expect((await fetch(`${url}/invocations`, { method: 'POST', body: '{not json' })).status).toBe(400);
    expect((await fetch(`${url}/v1/runs`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${url}/invocations`)).status).toBe(404);
    expect((await fetch(`${url}/invocations`, { method: 'POST', body: 'x'.repeat(11 * 1024 * 1024) }).catch(() => ({ status: 413 }))).status).toBe(413);
  });

  it('builds an ARM64 image, updates the runtime with its role, network and environment, and waits until it is ready', async () => {
    const plan = await planDeploy(target, await initialized({ ...runtime, environment: { DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:refunds/db' } }), { tag: 'v2' });
    expect(plan.steps.map(step => step.id)).toEqual(['check-account', 'build-image', 'push-image', 'update-runtime', 'runtime-ready']);
    expect(plan.steps[1]!.args).toEqual(['build', '--file', 'deploy/agentcore/Dockerfile', '--platform', 'linux/arm64', '--provenance=false', '--tag', `${image}:v2`, '.']);
    const update = plan.steps[3]!.args; const value = (flag: string) => update[update.indexOf(flag) + 1];
    expect(JSON.parse(value('--agent-runtime-artifact')!)).toEqual({ containerConfiguration: { containerUri: `${image}:v2` } });
    expect(value('--role-arn')).toBe(runtime.roleArn); expect(JSON.parse(value('--network-configuration')!)).toEqual({ networkMode: 'PUBLIC' });
    expect(JSON.parse(value('--environment-variables')!)).toEqual({ DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:refunds/db' });
    const { runner } = aws();
    expect((await runDeployPlan(plan, { confirmation: plan.digest, runner })).status).toBe('succeeded');
  }, 30_000);

  it('migrates first when asked, in a VPC, and stops when the update fails', async () => {
    const vpc = { mode: 'VPC', subnets: ['subnet-0abc1234def567890'], securityGroups: ['sg-0abc1234def567890'] };
    const plan = await planDeploy(target, await initialized({ ...runtime, migrate: true, network: vpc }), { tag: 'v2' });
    expect(plan.steps.map(step => step.id)).toEqual(['check-account', 'build-image', 'push-image', 'migrate', 'update-runtime', 'runtime-ready']);
    expect(JSON.parse(plan.steps[4]!.args[plan.steps[4]!.args.indexOf('--network-configuration') + 1]!))
      .toEqual({ networkMode: 'VPC', networkModeConfig: { subnets: vpc.subnets, securityGroups: vpc.securityGroups } });
    for (const [script, failed] of [[{ 'runtime-ready': ['UPDATING', 'UPDATE_FAILED'] }, 'runtime-ready'], [{ 'update-runtime': ['An error occurred (ValidationException)'] }, 'update-runtime']] as const) {
      const again = await planDeploy(target, await initialized(), { tag: 'v2' }); const { runner } = aws(script);
      expect((await runDeployPlan(again, { confirmation: again.digest, runner })).steps.find(step => step.status === 'failed')!.id).toBe(failed);
    }
  }, 60_000);

  it('needs the runtime, its role and an image to release, and refuses malformed settings', async () => {
    await expect(planDeploy(target, await initialized({}), { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('agentRuntimeId') });
    await expect(planDeploy(target, await initialized(runtime, { image: undefined }), { tag: 'v2' })).rejects.toMatchObject({ message: expect.stringContaining('ECR') });
    for (const [agent, message] of [[{ region: 'virginia' }, /region/u], [{ agentRuntimeId: 'refunds' }, /agentRuntimeId/u], [{ roleArn: 'admin' }, /roleArn/u], [{ migrate: 'yes' }, /migrate/u],
      [{ network: { mode: 'VPC', subnets: [] } }, /subnets|network/u], [{ network: { mode: 'OPEN' } }, /network/u], [{ environment: { db_url: 'x' } }, /environment/u],
      [{ module: '../agent.js' }, /module/u], [{ token: 'x' }, /allows only/u]] as const) {
      await expect(initialized(agent)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
    }
  });

  it('writes an image that serves the contract on port 8080', async () => {
    const root = await initialized();
    const docker = await readFile(join(root, 'deploy/agentcore/Dockerfile'), 'utf8');
    expect(docker).toContain('EXPOSE 8080'); expect(docker).toContain('CMD ["node", "deploy/agentcore/server.mjs"]');
    expect(await readFile(join(root, 'deploy/agentcore/server.mjs'), 'utf8')).toContain("import { invoke } from '../../dist/src/agentcore.js';");
  });
});
