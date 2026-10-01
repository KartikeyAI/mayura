import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployStep, type DeployTarget } from 'mayura/cli/deploy';
import awsLambdaTarget from '../src/index.js';

const target = awsLambdaTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const image = '123456789012.dkr.ecr.eu-west-1.amazonaws.com/refunds';
async function initialized(lambda: object = { region: 'eu-west-1' }, extra: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-lambda-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0', type: 'module' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', image, targets: { 'aws-lambda': lambda }, ...extra }));
  await applyDeployFiles(await planDeployFiles(target, root)); return root;
}
const aws = (overrides: Record<string, string> = {}) => {
  const ran: DeployStep[] = [];
  const outputs: Record<string, string> = { 'check-account': '123456789012', 'update-migrate': 'refunds-migrate', migrate: 'None', 'update-api': 'refunds-api', 'update-workflows': 'refunds-workflows', ...overrides };
  const runner: DeployRunner = async step => { ran.push(step); return { exitCode: 0, ...(step.output ? { output: `${outputs[step.id] ?? ''}\n` } : {}) }; };
  return { ran, runner };
};

describe('@mayurajs/deploy-aws-lambda', () => {
  it('writes a Lambda image on the AWS base image and three handlers that call the module', async () => {
    const root = await initialized({ region: 'eu-west-1', nodeVersion: 24 });
    const docker = await readFile(join(root, 'deploy/aws-lambda/Dockerfile'), 'utf8');
    expect(docker.match(/^FROM public\.ecr\.aws\/lambda\/nodejs:24/gmu)).toHaveLength(2);
    expect(docker).toContain('COPY deploy/aws-lambda/*.mjs ${LAMBDA_TASK_ROOT}/deploy/aws-lambda/');
    expect(await readFile(join(root, 'deploy/aws-lambda/api.mjs'), 'utf8')).toContain("import { handle } from '../../dist/src/mayura.js';");
    expect(await readFile(join(root, 'deploy/aws-lambda/workflows.mjs'), 'utf8')).toContain("import { advanceWorkflows } from '../../dist/src/mayura.js';");
    expect(await readFile(join(root, 'deploy/aws-lambda/migrate.mjs'), 'utf8')).toContain("import { migrate } from '../../dist/src/mayura.js';");
  });

  it('turns a function URL event into a Request for handle(), and the response back', async () => {
    const root = await initialized();
    await mkdir(join(root, 'dist', 'src'), { recursive: true });
    await writeFile(join(root, 'dist', 'src', 'mayura.js'), `export async function handle(request) {
  return new Response(JSON.stringify({ url: request.url, method: request.method, body: await request.text(), auth: request.headers.get('authorization') }), { status: 202, headers: { 'content-type': 'application/json' } });
}\n`);
    const { handler } = await import(pathToFileURL(join(root, 'deploy/aws-lambda/api.mjs')).href) as { handler: (event: object) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }> };
    const result = await handler({ rawPath: '/v1/runs', rawQueryString: 'wait=1', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: Buffer.from('{"input":2}').toString('base64'),
      isBase64Encoded: true, requestContext: { domainName: 'abc.lambda-url.eu-west-1.on.aws', http: { method: 'POST' } } });
    expect(result.statusCode).toBe(202); expect(result.headers['content-type']).toBe('application/json');
    expect(JSON.parse(result.body)).toEqual({ url: 'https://abc.lambda-url.eu-west-1.on.aws/v1/runs?wait=1', method: 'POST', body: '{"input":2}', auth: 'Bearer t' });
  });

  it('builds one single-platform image, migrates and checks it, then updates the API and workflows functions', async () => {
    const plan = await planDeploy(target, await initialized({ region: 'eu-west-1', architecture: 'arm64' }), { tag: 'v2' });
    expect(plan.steps.map(step => step.id)).toEqual(['check-account', 'build-image', 'push-image', 'update-migrate', 'wait-migrate', 'migrate', 'update-api', 'wait-api', 'update-workflows', 'wait-workflows']);
    expect(plan.steps[1]!.args).toEqual(['build', '--file', 'deploy/aws-lambda/Dockerfile', '--platform', 'linux/arm64', '--provenance=false', '--tag', `${image}:v2`, '.']);
    expect(plan.steps[3]!.args).toEqual(['lambda', 'update-function-code', '--region', 'eu-west-1', '--function-name', 'refunds-migrate', '--image-uri', `${image}:v2`, '--query', 'FunctionName', '--output', 'text']);
    expect(plan.steps[5]!.args.slice(0, -1)).toEqual(['lambda', 'invoke', '--region', 'eu-west-1', '--function-name', 'refunds-migrate', '--cli-read-timeout', '900', '--query', 'FunctionError', '--output', 'text']);
    const { runner } = aws();
    expect(await runDeployPlan(plan, { confirmation: plan.digest, runner })).toMatchObject({ status: 'succeeded' });
  });

  it('never updates the API when the migration reports a function error', async () => {
    for (const [overrides, failed] of [[{ migrate: 'Unhandled' }, 'migrate'], [{ 'update-migrate': 'An error occurred' }, 'update-migrate'], [{ 'check-account': '' }, 'check-account']] as const) {
      const plan = await planDeploy(target, await initialized(), { tag: 'v2' }); const { ran, runner } = aws(overrides);
      const result = await runDeployPlan(plan, { confirmation: plan.digest, runner });
      expect(result.steps.find(step => step.status === 'failed')!.id).toBe(failed); expect(ran.map(step => step.id)).not.toContain('update-api');
    }
  });

  it('needs a region and an image to release, and refuses malformed settings', async () => {
    await expect(planDeploy(target, await initialized({}), { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('region') });
    await expect(planDeploy(target, await initialized({ region: 'eu-west-1' }, { image: undefined }), { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('ECR') });
    for (const [lambda, message] of [[{ region: 'ireland' }, /region/u], [{ nodeVersion: 20 }, /nodeVersion/u], [{ architecture: 'arm' }, /architecture/u], [{ module: '../x.js' }, /module/u],
      [{ module: 'dist/mayura.ts' }, /module/u], [{ timeout: 9 }, /allows only/u]] as const) {
      await expect(initialized(lambda)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
    }
  });
});
