import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { defineDeployTarget, dockerignore, type DeployProject, type DeployStep } from 'mayura/cli/deploy';

export interface AgentCoreSettings {
  /** The region and the AgentCore Runtime's id (`name-XXXXXXXXXX`), from `create-agent-runtime`; a release needs both. */
  readonly region?: string;
  readonly agentRuntimeId?: string;
  /** The IAM role the runtime runs as; AgentCore requires it on every update. */
  readonly roleArn?: string;
  /** `PUBLIC` (default) or a VPC: its subnets and security groups. */
  readonly network: { readonly mode: 'PUBLIC' } | { readonly mode: 'VPC'; readonly subnets: readonly string[]; readonly securityGroups: readonly string[] };
  /**
   * The runtime's environment, set on every update: plain configuration only, such as a secret's ARN for the module to
   * read. Secret values never belong here.
   */
  readonly environment: Readonly<Record<string, string>>;
  /** Migrate storage from this machine before the update, with the DATABASE_URL in your environment; off by default. */
  readonly migrate: boolean;
  /** The compiled module exporting `invoke(payload, context)` (and `migrate()` when `migrate` is on); `agentcore.js` next to the app by default. */
  readonly module: string;
}

const allowed = ['region', 'agentRuntimeId', 'roleArn', 'network', 'environment', 'migrate', 'module'];
const fail = (message: string): never => { throw new MayuraError('INVALID_CONFIG', message); };
const nodeImage = 'node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5';

function settings(value: JsonValue | undefined, project: DeployProject): AgentCoreSettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return fail(`targets.agentcore allows only ${allowed.join(', ')}.`);
  const region = raw['region']; const id = raw['agentRuntimeId']; const role = raw['roleArn']; const migrate = raw['migrate'] ?? false;
  const module = raw['module'] ?? `${project.app.slice(0, project.app.lastIndexOf('/') + 1)}agentcore.js`;
  if (region !== undefined && (typeof region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(region))) fail('targets.agentcore.region must be an AWS region, such as us-east-1.');
  if (id !== undefined && (typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,99}-[a-zA-Z0-9]{10}$/u.test(id))) fail('targets.agentcore.agentRuntimeId must be an AgentCore Runtime id, such as refunds_agent-A1B2C3D4E5.');
  if (role !== undefined && (typeof role !== 'string' || !/^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/u.test(role))) fail('targets.agentcore.roleArn must be an IAM role ARN.');
  if (typeof migrate !== 'boolean') fail('targets.agentcore.migrate must be true or false.');
  if (typeof module !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}\.(?:js|mjs)$/u.test(module)) fail('targets.agentcore.module must be the compiled module\'s path inside the project, such as dist/src/agentcore.js.');
  const rawNetwork = raw['network'] ?? { mode: 'PUBLIC' }; let network: AgentCoreSettings['network'];
  if (!rawNetwork || typeof rawNetwork !== 'object' || Array.isArray(rawNetwork)) return fail('targets.agentcore.network must be { "mode": "PUBLIC" } or a VPC.');
  const shape = rawNetwork as JsonObject;
  if (shape['mode'] === 'PUBLIC' && Object.keys(shape).length === 1) network = { mode: 'PUBLIC' };
  else if (shape['mode'] === 'VPC' && Object.keys(shape).every(key => ['mode', 'subnets', 'securityGroups'].includes(key))) {
    const ids = (item: JsonValue | undefined, pattern: RegExp, name: string): string[] => (Array.isArray(item) && item.length > 0 && item.length <= 16 && item.every(entry => typeof entry === 'string' && pattern.test(entry))
      ? item as string[] : fail(`targets.agentcore.network.${name} must list ${name === 'subnets' ? 'subnet' : 'security group'} ids.`));
    network = { mode: 'VPC', subnets: ids(shape['subnets'], /^subnet-[0-9a-f]{8,17}$/u, 'subnets'), securityGroups: ids(shape['securityGroups'], /^sg-[0-9a-f]{8,17}$/u, 'securityGroups') };
  } else return fail('targets.agentcore.network must be { "mode": "PUBLIC" } or { "mode": "VPC", "subnets": [...], "securityGroups": [...] }.');
  const rawEnvironment = raw['environment'] ?? {};
  if (!rawEnvironment || typeof rawEnvironment !== 'object' || Array.isArray(rawEnvironment) || Object.keys(rawEnvironment).length > 50) fail('targets.agentcore.environment maps variable names to values.');
  for (const [name, entry] of Object.entries(rawEnvironment as JsonObject)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name) || typeof entry !== 'string' || entry.length > 4_096) fail(`targets.agentcore.environment.${name} must be a string value.`);
  }
  return { ...(region === undefined ? {} : { region: region as string }), ...(id === undefined ? {} : { agentRuntimeId: id as string }), ...(role === undefined ? {} : { roleArn: role as string }),
    network, environment: rawEnvironment as Record<string, string>, migrate: migrate as boolean, module: module as string };
}

function files(agent: AgentCoreSettings): Record<string, string> {
  const from = (depth: number) => `${'../'.repeat(depth)}${agent.module}`;
  return {
    '.dockerignore': dockerignore,
    'deploy/agentcore/Dockerfile': `# The AgentCore Runtime image: ARM64, serving AgentCore's HTTP contract on port 8080 (deploy/agentcore/server.mjs).
FROM ${nodeImage} AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM ${nodeImage}
WORKDIR /app
COPY --from=build --chown=65532:65532 /app/package.json ./
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --chown=65532:65532 deploy/agentcore/server.mjs ./deploy/agentcore/server.mjs
USER 65532:65532
ENV NODE_ENV=production MAYURA_ENV=production
EXPOSE 8080
CMD ["node", "deploy/agentcore/server.mjs"]
`,
    'deploy/agentcore/server.mjs': `// AgentCore Runtime's HTTP contract for a Mayura module: POST /invocations calls invoke(payload, context), and GET /ping
// reports HealthyBusy while invocations run, so AgentCore keeps the session alive. AgentCore authenticates callers.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { invoke } from '${from(2)}';

const limit = 10 * 1024 * 1024;
let running = 0;
const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };

const server = createServer(async (request, response) => {
  const path = (request.url ?? '').split('?')[0];
  if (request.method === 'GET' && path === '/ping') return send(response, 200, { status: running > 0 ? 'HealthyBusy' : 'Healthy' });
  if (request.method !== 'POST' || path !== '/invocations') return send(response, 404, { error: 'not_found' });
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) return send(response, 413, { error: 'payload_too_large' }); chunks.push(chunk); }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { return send(response, 400, { error: 'invalid_json' }); }
  const controller = new AbortController();
  response.on('close', () => { if (!response.writableFinished) controller.abort(); });
  running += 1;
  try {
    const result = await invoke(payload, { sessionId: request.headers['x-amzn-bedrock-agentcore-runtime-session-id'], signal: controller.signal });
    if (result instanceof Response) {
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) Readable.fromWeb(result.body).pipe(response); else response.end();
    } else send(response, 200, result ?? null);
  } catch {
    // The error's text stays in the container's logs, never in the response.
    if (!response.headersSent) send(response, 500, { error: 'invocation_failed' }); else response.destroy();
  } finally { running -= 1; }
});

server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log(\`listening on \${server.address().port}\`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
    'deploy/agentcore/migrate.mjs': `// Run by mayura deploy before the update when targets.agentcore.migrate is on: migrates with your DATABASE_URL.
import { migrate } from '${from(2)}';

console.log(JSON.stringify(await migrate()));
`,
  };
}

/** Deploys a Mayura agent to Amazon Bedrock AgentCore Runtime: an ARM64 image serving its HTTP contract, then the runtime update. */
export const agentCoreTarget = defineDeployTarget<AgentCoreSettings>({
  id: 'agentcore', description: 'Deploy to Amazon Bedrock AgentCore Runtime: an ARM64 image serving its HTTP contract, then the runtime update.', tools: ['aws', 'docker', 'node'],
  settings,
  files: ({ settings: agent }) => files(agent),
  plan: async ({ settings: agent, release, readFile }) => {
    for (const path of ['deploy/agentcore/Dockerfile', 'deploy/agentcore/server.mjs', 'deploy/agentcore/migrate.mjs']) await readFile(path);
    if (agent.region === undefined || agent.agentRuntimeId === undefined || agent.roleArn === undefined) {
      return fail('Set targets.agentcore.region, agentRuntimeId and roleArn once the runtime exists (aws bedrock-agentcore-control create-agent-runtime).');
    }
    if (release.image === undefined) return fail('AgentCore runs an image: set "image" in mayura.deploy.json to an ECR repository.');
    const image = release.image; const at = ['--region', agent.region];
    const network = agent.network.mode === 'PUBLIC' ? { networkMode: 'PUBLIC' }
      : { networkMode: 'VPC', networkModeConfig: { subnets: agent.network.subnets, securityGroups: agent.network.securityGroups } };
    const steps: DeployStep[] = [
      { id: 'check-account', description: 'Check that the AWS CLI is signed in', tool: 'aws', args: ['sts', 'get-caller-identity', ...at, '--query', 'Account', '--output', 'text'], output: { match: '\\d{12}' } },
      // AgentCore runs ARM64 containers; a single-platform manifest without an attestation.
      { id: 'build-image', description: `Build ${image} for ARM64`, tool: 'docker', args: ['build', '--file', 'deploy/agentcore/Dockerfile', '--platform', 'linux/arm64', '--provenance=false', '--tag', image, '.'] },
      { id: 'push-image', description: `Push ${image}`, tool: 'docker', args: ['push', image] },
    ];
    if (agent.migrate) steps.push({ id: 'migrate', description: 'Migrate storage with the DATABASE_URL in your environment', tool: 'node', args: ['deploy/agentcore/migrate.mjs'] });
    steps.push(
      { id: 'update-runtime', description: `Update ${agent.agentRuntimeId} to the new image`, tool: 'aws',
        args: ['bedrock-agentcore-control', 'update-agent-runtime', ...at, '--agent-runtime-id', agent.agentRuntimeId,
          '--agent-runtime-artifact', JSON.stringify({ containerConfiguration: { containerUri: image } }), '--role-arn', agent.roleArn,
          '--network-configuration', JSON.stringify(network), '--protocol-configuration', JSON.stringify({ serverProtocol: 'HTTP' }),
          '--environment-variables', JSON.stringify(agent.environment), '--query', 'status', '--output', 'text'],
        output: { match: 'UPDATING|READY' } },
      { id: 'runtime-ready', description: 'Wait until the runtime is ready', tool: 'aws',
        args: ['bedrock-agentcore-control', 'get-agent-runtime', ...at, '--agent-runtime-id', agent.agentRuntimeId, '--query', 'status', '--output', 'text'],
        output: { match: 'READY', retry: { while: 'UPDATING', attempts: 120, intervalSeconds: 5 } } },
    );
    return steps;
  },
});

export default agentCoreTarget;
