import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { IMAGE_PLACEHOLDER, defineDeployTarget, dockerfile, dockerignore, imageSteps, type DeployProject } from 'mayura/cli/deploy';

export interface AwsEcsSettings {
  readonly region: string;
  readonly cluster: string;
  /** Where the migration task runs: the services' subnets and security groups. */
  readonly subnets: readonly string[];
  readonly securityGroups: readonly string[];
  readonly assignPublicIp: boolean;
  /** The role ECS uses to pull the image, read secrets and write logs. */
  readonly executionRoleArn: string;
  /** The role the application runs as, when it calls AWS. */
  readonly taskRoleArn?: string;
  /** Fargate task size: `512` CPU units and `1024` MiB by default. */
  readonly cpu: string;
  readonly memory: string;
  /** Environment variables from Secrets Manager or SSM Parameter Store, by ARN. */
  readonly secrets: Readonly<Record<string, string>>;
}

const allowed = ['region', 'cluster', 'subnets', 'securityGroups', 'assignPublicIp', 'executionRoleArn', 'taskRoleArn', 'cpu', 'memory', 'secrets', 'secretPrefix'];
const partition = 'arn:aws(?:-[a-z]+)*';
const regionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d$/u;
const rolePattern = new RegExp(`^${partition}:iam::\\d{12}:role/[\\w+=,.@/-]{1,512}$`, 'u');
const secretPattern = new RegExp(`^${partition}:(?:secretsmanager:[a-z0-9-]+:\\d{12}:secret:|ssm:[a-z0-9-]+:\\d{12}:parameter/)[\\w+=,.@/-]{1,512}$`, 'u');
const fail = (message: string): never => { throw new MayuraError('INVALID_CONFIG', message); };

function list(value: JsonValue | undefined, pattern: RegExp, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16 || value.some(item => typeof item !== 'string' || !pattern.test(item))) return fail(`targets.aws-ecs.${name} must list ${name === 'subnets' ? 'subnet ids (subnet-…)' : 'security group ids (sg-…)'}.`);
  return value as string[];
}

function settings(value: JsonValue | undefined, project: DeployProject): AwsEcsSettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return fail(`targets.aws-ecs allows only ${allowed.join(', ')}.`);
  const region = raw['region']; const cluster = raw['cluster']; const executionRoleArn = raw['executionRoleArn']; const taskRoleArn = raw['taskRoleArn'];
  if (typeof region !== 'string' || !regionPattern.test(region)) fail('targets.aws-ecs.region must be an AWS region, such as eu-west-1.');
  if (typeof cluster !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/u.test(cluster)) fail('targets.aws-ecs.cluster must be the ECS cluster name.');
  if (typeof executionRoleArn !== 'string' || !rolePattern.test(executionRoleArn)) fail('targets.aws-ecs.executionRoleArn must be an IAM role ARN.');
  if (taskRoleArn !== undefined && (typeof taskRoleArn !== 'string' || !rolePattern.test(taskRoleArn))) fail('targets.aws-ecs.taskRoleArn must be an IAM role ARN.');
  const assignPublicIp = raw['assignPublicIp'] ?? false; if (typeof assignPublicIp !== 'boolean') fail('targets.aws-ecs.assignPublicIp must be true or false.');
  const cpu = raw['cpu'] ?? '512'; const memory = raw['memory'] ?? '1024';
  if (typeof cpu !== 'string' || !['256', '512', '1024', '2048', '4096', '8192', '16384'].includes(cpu)) fail('targets.aws-ecs.cpu must be a Fargate CPU size, such as "512".');
  if (typeof memory !== 'string' || !/^\d{3,6}$/u.test(memory) || Number(memory) < 512 || Number(memory) > 122_880) fail('targets.aws-ecs.memory must be MiB as a string, such as "1024".');
  // Every variable the app reads, and DATABASE_URL, comes from a secret: by name in `secrets`, or under `secretPrefix`.
  const prefix = raw['secretPrefix']; const mapped = raw['secrets'] ?? {};
  if (prefix !== undefined && (typeof prefix !== 'string' || !secretPattern.test(`${prefix}NAME`))) fail('targets.aws-ecs.secretPrefix must be the start of a Secrets Manager or SSM ARN.');
  if (!mapped || typeof mapped !== 'object' || Array.isArray(mapped)) fail('targets.aws-ecs.secrets maps variable names to secret ARNs.');
  const secrets: Record<string, string> = {}; const missing: string[] = [];
  for (const name of new Set(['DATABASE_URL', ...project.env, ...Object.keys(mapped as JsonObject)])) {
    const reference = (mapped as JsonObject)[name] ?? (prefix === undefined ? undefined : `${prefix as string}${name}`);
    if (reference === undefined) { missing.push(name); continue; }
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name) || typeof reference !== 'string' || !secretPattern.test(reference)) fail(`targets.aws-ecs.secrets.${name} must be a Secrets Manager or SSM parameter ARN.`);
    secrets[name] = reference as string;
  }
  if (missing.length) fail(`targets.aws-ecs needs a secret for ${missing.join(', ')}: map each in secrets, or set secretPrefix.`);
  return { region: region as string, cluster: cluster as string, subnets: list(raw['subnets'], /^subnet-[0-9a-f]{8,17}$/u, 'subnets'), securityGroups: list(raw['securityGroups'], /^sg-[0-9a-f]{8,17}$/u, 'securityGroups'),
    assignPublicIp: assignPublicIp as boolean, executionRoleArn: executionRoleArn as string, ...(taskRoleArn === undefined ? {} : { taskRoleArn: taskRoleArn as string }),
    cpu: cpu as string, memory: memory as string, secrets };
}

function taskDefinition(project: DeployProject, ecs: AwsEcsSettings, role: 'server' | 'worker'): string {
  const port = role === 'server' ? project.port : project.probePort;
  const command = role === 'server' ? ['serve', '--app', project.app] : ['worker', '--app', project.app, '--probe-host', '0.0.0.0', '--probe-port', String(project.probePort)];
  return `${JSON.stringify({
    family: `${project.name}-${role}`, requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', cpu: ecs.cpu, memory: ecs.memory,
    executionRoleArn: ecs.executionRoleArn, ...(ecs.taskRoleArn === undefined ? {} : { taskRoleArn: ecs.taskRoleArn }),
    containerDefinitions: [{
      name: 'app', image: IMAGE_PLACEHOLDER, essential: true, command, stopTimeout: 45,
      portMappings: [{ containerPort: port, protocol: 'tcp' }],
      secrets: Object.entries(ecs.secrets).map(([name, valueFrom]) => ({ name, valueFrom })),
      healthCheck: { command: ['CMD', 'wget', '-q', '-O', '/dev/null', `http://127.0.0.1:${port}/readyz`], interval: 15, timeout: 5, retries: 3, startPeriod: 30 },
      logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': `/ecs/${project.name}`, 'awslogs-region': ecs.region, 'awslogs-stream-prefix': role, 'awslogs-create-group': 'true' } },
    }],
  }, null, 2)}\n`;
}

const files = { server: 'deploy/aws-ecs/server-task.json', worker: 'deploy/aws-ecs/worker-task.json' } as const;
const taskDefinitionArn = `${partition}:ecs:[a-z0-9-]+:\\d{12}:task-definition/[A-Za-z0-9_-]{1,255}:\\d{1,10}`;
const taskArn = `${partition}:ecs:[a-z0-9-]+:\\d{12}:task/[A-Za-z0-9_/-]{1,512}`;

/** A task definition file with the release's image, as compact JSON; its family must stay the one the services use. */
function rendered(text: string, path: string, image: string, family: string): string {
  let value: JsonObject;
  try { value = JSON.parse(text) as JsonObject; } catch { return fail(`${path} is not valid JSON.`); }
  if (!text.includes(IMAGE_PLACEHOLDER)) fail(`${path} must keep the image placeholder ${IMAGE_PLACEHOLDER}.`);
  if (value['family'] !== family) fail(`${path} must keep the family ${family}.`);
  return JSON.stringify(JSON.parse(text.replaceAll(IMAGE_PLACEHOLDER, image)));
}

/** Deploys to Amazon ECS on Fargate with the AWS CLI: task definitions, a migration task it waits for, then the services. */
export const awsEcsTarget = defineDeployTarget<AwsEcsSettings>({
  id: 'aws-ecs', description: 'Deploy to Amazon ECS on Fargate with the AWS CLI: task definitions, a migration task, then the server and worker services.', tools: ['aws', 'docker'],
  settings,
  files: ({ project, settings: ecs }) => ({
    Dockerfile: dockerfile(project), '.dockerignore': dockerignore,
    [files.server]: taskDefinition(project, ecs, 'server'), [files.worker]: taskDefinition(project, ecs, 'worker'),
  }),
  plan: async ({ project, settings: ecs, release, readFile }) => {
    if (release.image === undefined) return fail('ECS runs an image: set "image" in mayura.deploy.json to an ECR repository.');
    const image = release.image; const at = ['--region', ecs.region]; const inCluster = [...at, '--cluster', ecs.cluster];
    const server = rendered(await readFile(files.server), files.server, image, `${project.name}-server`);
    const worker = rendered(await readFile(files.worker), files.worker, image, `${project.name}-worker`);
    const network = JSON.stringify({ awsvpcConfiguration: { subnets: ecs.subnets, securityGroups: ecs.securityGroups, assignPublicIp: ecs.assignPublicIp ? 'ENABLED' : 'DISABLED' } });
    const migrate = JSON.stringify({ containerOverrides: [{ name: 'app', command: ['migrate', '--app', project.app] }] });
    const register = (definition: string) => ['ecs', 'register-task-definition', ...at, '--cli-input-json', definition, '--query', 'taskDefinition.taskDefinitionArn', '--output', 'text'];
    const update = (role: 'server' | 'worker', revision: string) => ['ecs', 'update-service', ...inCluster, '--service', `${project.name}-${role}`, '--task-definition', revision, '--query', 'service.serviceName', '--output', 'text'];
    return [
      { id: 'check-account', description: 'Check that the AWS CLI is signed in', tool: 'aws', args: ['sts', 'get-caller-identity', ...at, '--query', 'Account', '--output', 'text'], output: { match: '\\d{12}' } },
      ...imageSteps(release, 'aws-ecs'),
      { id: 'register-server', description: `Register ${project.name}-server at the new image`, tool: 'aws', args: register(server), output: { match: taskDefinitionArn, as: 'serverTask' } },
      { id: 'register-worker', description: `Register ${project.name}-worker at the new image`, tool: 'aws', args: register(worker), output: { match: taskDefinitionArn, as: 'workerTask' } },
      { id: 'migrate', description: 'Start the migration as a one-off task', tool: 'aws',
        args: ['ecs', 'run-task', ...inCluster, '--launch-type', 'FARGATE', '--task-definition', '{{serverTask}}', '--overrides', migrate, '--network-configuration', network,
          '--started-by', 'mayura-deploy', '--query', 'tasks[0].taskArn', '--output', 'text'], output: { match: taskArn, as: 'migration' } },
      { id: 'migrate-wait', description: 'Wait for the migration to stop', tool: 'aws', args: ['ecs', 'wait', 'tasks-stopped', ...inCluster, '--tasks', '{{migration}}'] },
      // ECS reports a task as stopped whether it succeeded or not: the migration's exit code decides.
      { id: 'migrate-check', description: 'Check that the migration succeeded', tool: 'aws',
        args: ['ecs', 'describe-tasks', ...inCluster, '--tasks', '{{migration}}', '--query', 'tasks[0].containers[0].exitCode', '--output', 'text'], output: { match: '0' } },
      { id: 'roll-out-server', description: `Roll out ${project.name}-server`, tool: 'aws', args: update('server', '{{serverTask}}'), output: { match: `${project.name}-server` } },
      { id: 'roll-out-worker', description: `Roll out ${project.name}-worker`, tool: 'aws', args: update('worker', '{{workerTask}}'), output: { match: `${project.name}-worker` } },
      { id: 'wait-stable', description: 'Wait for both services to be stable', tool: 'aws', args: ['ecs', 'wait', 'services-stable', ...inCluster, '--services', `${project.name}-server`, `${project.name}-worker`] },
    ];
  },
});

export default awsEcsTarget;
