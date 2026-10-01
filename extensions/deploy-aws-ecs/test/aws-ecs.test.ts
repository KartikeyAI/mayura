import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployStep, type DeployTarget } from 'mayura/cli/deploy';
import awsEcsTarget from '../src/index.js';

const target = awsEcsTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const image = '123456789012.dkr.ecr.eu-west-1.amazonaws.com/refunds';
const role = 'arn:aws:iam::123456789012:role/refunds-execution';
const prefix = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:refunds/';
const ecs = { region: 'eu-west-1', cluster: 'agents', subnets: ['subnet-0abc1234def567890'], securityGroups: ['sg-0abc1234def567890'], executionRoleArn: role, secretPrefix: prefix };
async function project(settings: object = ecs): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-ecs-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', image, env: ['OPENAI_API_KEY'], targets: { 'aws-ecs': settings } }));
  return root;
}
async function initialized(settings: object = ecs): Promise<string> { const root = await project(settings); await applyDeployFiles(await planDeployFiles(target, root)); return root; }
const serverArn = 'arn:aws:ecs:eu-west-1:123456789012:task-definition/refunds-server:7';
const workerArn = 'arn:aws:ecs:eu-west-1:123456789012:task-definition/refunds-worker:7';
const taskArn = 'arn:aws:ecs:eu-west-1:123456789012:task/agents/0a1b2c3d4e5f';
/** A fake AWS CLI: the outputs a successful release prints, overridable per step. */
const aws = (overrides: Record<string, string> = {}) => {
  const ran: DeployStep[] = [];
  const outputs: Record<string, string> = { 'check-account': '123456789012', 'register-server': serverArn, 'register-worker': workerArn, migrate: taskArn, 'migrate-check': '0',
    'roll-out-server': 'refunds-server', 'roll-out-worker': 'refunds-worker', ...overrides };
  const runner: DeployRunner = async step => { ran.push(step); return { exitCode: 0, ...(step.output ? { output: `${outputs[step.id] ?? ''}\n` } : {}) }; };
  return { ran, runner };
};

describe('@mayurajs/deploy-aws-ecs', () => {
  it('writes Fargate task definitions for the server and worker: image placeholder, secrets by ARN, health checks, logs', async () => {
    const root = await initialized({ ...ecs, secrets: { OPENAI_API_KEY: 'arn:aws:ssm:eu-west-1:123456789012:parameter/refunds/openai' }, taskRoleArn: 'arn:aws:iam::123456789012:role/refunds-app' });
    const server = JSON.parse(await readFile(join(root, 'deploy/aws-ecs/server-task.json'), 'utf8'));
    expect(server).toMatchObject({ family: 'refunds-server', requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', cpu: '512', memory: '1024', executionRoleArn: role,
      taskRoleArn: 'arn:aws:iam::123456789012:role/refunds-app' });
    expect(server.containerDefinitions[0]).toMatchObject({ name: 'app', image: 'mayura-app-image', command: ['serve', '--app', 'dist/src/app.js'], portMappings: [{ containerPort: 8080 }],
      secrets: [{ name: 'DATABASE_URL', valueFrom: `${prefix}DATABASE_URL` }, { name: 'OPENAI_API_KEY', valueFrom: 'arn:aws:ssm:eu-west-1:123456789012:parameter/refunds/openai' }],
      healthCheck: { command: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/readyz'] }, logConfiguration: { options: { 'awslogs-group': '/ecs/refunds', 'awslogs-stream-prefix': 'server' } } });
    const worker = JSON.parse(await readFile(join(root, 'deploy/aws-ecs/worker-task.json'), 'utf8'));
    expect(worker.containerDefinitions[0]).toMatchObject({ command: ['worker', '--app', 'dist/src/app.js', '--probe-host', '0.0.0.0', '--probe-port', '9090'], portMappings: [{ containerPort: 9090 }] });
  });

  it('registers the task definitions, migrates with a one-off task it checks, then rolls out both services at the new revisions', async () => {
    const plan = await planDeploy(target, await initialized(), { tag: 'v2' }); const { ran, runner } = aws();
    expect(plan.steps.map(step => step.id)).toEqual(['check-account', 'build-image', 'push-image', 'register-server', 'register-worker', 'migrate', 'migrate-wait', 'migrate-check',
      'roll-out-server', 'roll-out-worker', 'wait-stable']);
    const registered = JSON.parse(plan.steps[3]!.args[plan.steps[3]!.args.indexOf('--cli-input-json') + 1]!);
    expect(registered.containerDefinitions[0].image).toBe(`${image}:v2`);
    expect(await runDeployPlan(plan, { confirmation: plan.digest, runner })).toMatchObject({ status: 'succeeded' });
    const args = (id: string) => ran.find(step => step.id === id)!.args;
    expect(args('migrate')).toEqual(expect.arrayContaining(['--task-definition', serverArn, '--launch-type', 'FARGATE',
      '--overrides', JSON.stringify({ containerOverrides: [{ name: 'app', command: ['migrate', '--app', 'dist/src/app.js'] }] }),
      '--network-configuration', JSON.stringify({ awsvpcConfiguration: { subnets: ecs.subnets, securityGroups: ecs.securityGroups, assignPublicIp: 'DISABLED' } })]));
    expect(args('migrate-wait')).toEqual(['ecs', 'wait', 'tasks-stopped', '--region', 'eu-west-1', '--cluster', 'agents', '--tasks', taskArn]);
    expect(args('roll-out-server')).toEqual(expect.arrayContaining(['--service', 'refunds-server', '--task-definition', serverArn]));
    expect(args('roll-out-worker')).toEqual(expect.arrayContaining(['--service', 'refunds-worker', '--task-definition', workerArn]));
    expect(args('wait-stable')).toEqual(['ecs', 'wait', 'services-stable', '--region', 'eu-west-1', '--cluster', 'agents', '--services', 'refunds-server', 'refunds-worker']);
  });

  it('never rolls out when the migration exits non-zero, or when the CLI prints something unexpected', async () => {
    const root = await initialized();
    for (const [overrides, failed] of [[{ 'migrate-check': '1' }, 'migrate-check'], [{ 'migrate-check': 'None' }, 'migrate-check'], [{ migrate: 'None' }, 'migrate'],
      [{ 'register-server': 'An error occurred' }, 'register-server'], [{ 'check-account': '' }, 'check-account']] as const) {
      const plan = await planDeploy(target, root, { tag: 'v2' }); const { ran, runner } = aws(overrides);
      const result = await runDeployPlan(plan, { confirmation: plan.digest, runner });
      expect(result.status).toBe('failed'); expect(result.steps.find(step => step.status === 'failed')!.id).toBe(failed);
      expect(ran.map(step => step.id)).not.toContain('roll-out-server');
    }
  });

  it('needs an ECR image to release', async () => {
    const root = await initialized(); const config = JSON.parse(await readFile(join(root, 'mayura.deploy.json'), 'utf8')); delete config.image;
    await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify(config));
    await expect(planDeploy(target, root, { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('ECR') });
  });

  it('refuses edited task definitions that lost their image placeholder or family', async () => {
    const root = await initialized(); const path = join(root, 'deploy/aws-ecs/server-task.json'); const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('mayura-app-image', 'nginx'));
    await expect(planDeploy(target, root, { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('placeholder') });
    await writeFile(path, original.replace('"refunds-server"', '"other"'));
    await expect(planDeploy(target, root, { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('family') });
    await writeFile(path, '{');
    await expect(planDeploy(target, root, { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('JSON') });
  });

  it.each([
    [{ ...ecs, region: 'europe' }, /region/u], [{ ...ecs, cluster: 'a b' }, /cluster/u], [{ ...ecs, subnets: [] }, /subnets/u], [{ ...ecs, securityGroups: ['default'] }, /securityGroups/u],
    [{ ...ecs, executionRoleArn: 'refunds-role' }, /executionRoleArn/u], [{ ...ecs, cpu: '300' }, /cpu/u], [{ ...ecs, memory: '256' }, /memory/u], [{ ...ecs, assignPublicIp: 'yes' }, /assignPublicIp/u],
    [{ ...ecs, secretPrefix: undefined }, /DATABASE_URL, OPENAI_API_KEY/u], [{ ...ecs, secrets: { DATABASE_URL: 'postgres://user:pw@db/app' } }, /DATABASE_URL/u], [{ ...ecs, token: 'x' }, /allows only/u],
  ])('refuses incomplete or malformed settings (%#)', async (settings, message) => {
    await expect(planDeployFiles(target, await project(settings))).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
  });
});
