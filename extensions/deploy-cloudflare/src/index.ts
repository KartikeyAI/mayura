import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { defineDeployTarget, dockerfile, dockerignore, type DeployProject, type DeployStep } from 'mayura/cli/deploy';

/** Containers run the app module in Cloudflare Containers; Workers run the serverless module at the edge. */
export type CloudflareRuntime = 'containers' | 'workers';

export interface CloudflareSettings {
  readonly runtime: CloudflareRuntime;
  /** The Worker's name: the project name by default. */
  readonly name: string;
  /** Containers: at most this many server instances, which requests are spread across (3 by default). */
  readonly maxInstances: number;
  /** Workers: the serverless module, exporting `handle(request, env)` and `advanceWorkflows(budgetMs, env)`; `src/mayura.ts` by default. */
  readonly module: string;
  /** Advance workflows (Workers) or keep the worker container awake (Containers) every minute; on by default. */
  readonly cron: boolean;
}

const allowed = ['runtime', 'name', 'maxInstances', 'module', 'cron'];
const fail = (message: string): never => { throw new MayuraError('INVALID_CONFIG', message); };
/** The Workers runtime behaviour these files were written against. */
const compatibilityDate = '2026-09-15';

function settings(value: JsonValue | undefined, project: DeployProject): CloudflareSettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return fail(`targets.cloudflare allows only ${allowed.join(', ')}.`);
  const runtime = raw['runtime'] ?? 'containers'; const name = raw['name'] ?? project.name; const instances = raw['maxInstances'] ?? 3;
  const module = raw['module'] ?? 'src/mayura.ts'; const cron = raw['cron'] ?? true;
  if (runtime !== 'containers' && runtime !== 'workers') fail('targets.cloudflare.runtime must be containers or workers.');
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name)) fail('targets.cloudflare.name must be a Worker name: lowercase letters, digits and hyphens.');
  if (typeof instances !== 'number' || !Number.isSafeInteger(instances) || instances < 1 || instances > 100) fail('targets.cloudflare.maxInstances must be from 1 to 100.');
  if (typeof module !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}\.(?:ts|js|mjs)$/u.test(module)) fail('targets.cloudflare.module must be the serverless module\'s path inside the project, such as src/mayura.ts.');
  if (typeof cron !== 'boolean') fail('targets.cloudflare.cron must be true or false.');
  return { runtime, name: name as string, maxInstances: instances as number, module: module as string, cron: cron as boolean } as CloudflareSettings;
}

function containerFiles(project: DeployProject, cloudflare: CloudflareSettings): Record<string, string> {
  // The worker's image: the same build, whose command runs the workflow worker with its probes.
  const workerImage = dockerfile(project).replace(`CMD ["serve", "--app", "${project.app}"]`,
    `CMD ["worker", "--app", "${project.app}", "--probe-host", "0.0.0.0", "--probe-port", "${project.probePort}"]`);
  const secrets = ['DATABASE_URL', ...project.env.filter(name => name !== 'DATABASE_URL')];
  return {
    Dockerfile: dockerfile(project), '.dockerignore': dockerignore, 'deploy/cloudflare/worker.Dockerfile': workerImage,
    'wrangler.jsonc': `${JSON.stringify({
      $schema: 'node_modules/wrangler/config-schema.json', name: cloudflare.name, main: 'deploy/cloudflare/worker.js', compatibility_date: compatibilityDate,
      containers: [{ class_name: 'MayuraServer', image: './Dockerfile', max_instances: cloudflare.maxInstances }, { class_name: 'MayuraWorker', image: './deploy/cloudflare/worker.Dockerfile', max_instances: 1 }],
      durable_objects: { bindings: [{ name: 'SERVER', class_name: 'MayuraServer' }, { name: 'WORKER', class_name: 'MayuraWorker' }] },
      exports: { MayuraServer: { type: 'durable-object', storage: 'sqlite' }, MayuraWorker: { type: 'durable-object', storage: 'sqlite' } },
      ...(cloudflare.cron ? { triggers: { crons: ['* * * * *'] } } : {}),
    }, null, 2)}\n`,
    'deploy/cloudflare/worker.js': `// Cloudflare Containers for a Mayura app: the server container answers /v1/*, spread across up to ${cloudflare.maxInstances} instances, and
// one worker container advances workflows, kept awake by a cron trigger every minute. Secrets come from
// \`wrangler secret put\` and reach both containers as environment variables.
import { Container, getContainer, getRandom } from '@cloudflare/containers';

const secrets = ${JSON.stringify(secrets)};
const environment = env => Object.fromEntries(secrets.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));

export class MayuraServer extends Container {
  defaultPort = ${project.port};
  sleepAfter = '10m';
  constructor(ctx, env) { super(ctx, env); this.envVars = { ...environment(env), PORT: '${project.port}' }; }
}

export class MayuraWorker extends Container {
  defaultPort = ${project.probePort};
  sleepAfter = '5m';
  constructor(ctx, env) { super(ctx, env); this.envVars = { ...environment(env), MAYURA_WORKER_ID: 'cloudflare-worker' }; }
}

export default {
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith('/v1/')) return new Response('Not found', { status: 404 });
    return (await getRandom(env.SERVER, ${cloudflare.maxInstances})).fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    // A request to the worker's probe starts it if it slept and keeps it awake.
    ctx.waitUntil(getContainer(env.WORKER, 'workflows').fetch(new Request('http://container/readyz')));
  },
};
`,
  };
}

function workerFiles(cloudflare: CloudflareSettings): Record<string, string> {
  return {
    'wrangler.jsonc': `${JSON.stringify({
      $schema: 'node_modules/wrangler/config-schema.json', name: cloudflare.name, main: 'deploy/cloudflare/worker.ts', compatibility_date: compatibilityDate,
      compatibility_flags: ['nodejs_compat'], ...(cloudflare.cron ? { triggers: { crons: ['* * * * *'] } } : {}),
    }, null, 2)}\n`,
    'deploy/cloudflare/worker.ts': `// Mayura on Cloudflare Workers: requests go to the serverless module's handle(), and a cron trigger advances
// workflows every minute within a budget well under the invocation's limit. Bindings (D1, Hyperdrive) arrive in env.
import { advanceWorkflows, handle } from '../../${cloudflare.module.replace(/\.ts$/u, '.js')}';

export default {
  fetch: (request: Request, env: unknown) => handle(request, env),
  scheduled: (_controller: unknown, env: unknown, ctx: { waitUntil(promise: Promise<unknown>): void }) => { ctx.waitUntil(advanceWorkflows(20_000, env)); },
};
`,
  };
}

/** Deploys to Cloudflare with wrangler: the app in Cloudflare Containers, or the serverless module on Workers. */
export const cloudflareTarget = defineDeployTarget<CloudflareSettings>({
  id: 'cloudflare', description: 'Deploy to Cloudflare with wrangler: the app in Containers (server and worker), or the serverless module on Workers.', tools: ['wrangler', 'npm', 'node'],
  settings,
  files: ({ project, settings: cloudflare }) => (cloudflare.runtime === 'containers' ? containerFiles(project, cloudflare) : workerFiles(cloudflare)),
  plan: async ({ project, settings: cloudflare, readFile }) => {
    const config = await readFile('wrangler.jsonc');
    const containers = cloudflare.runtime === 'containers';
    if (containers !== config.includes('"containers"')) return fail(`wrangler.jsonc was written for the other runtime: run mayura deploy init --target cloudflare again.`);
    await readFile(containers ? 'deploy/cloudflare/worker.js' : 'deploy/cloudflare/worker.ts');
    const steps: DeployStep[] = [{ id: 'check-login', description: 'Check that wrangler is logged in', tool: 'wrangler', args: ['whoami'] }];
    // Containers have no pre-deploy step: storage is migrated from here, with the DATABASE_URL in your environment. On
    // Workers the module initializes storage itself, under the schema lock.
    if (containers) steps.push(
      { id: 'build', description: 'Build the project here, for the migration', tool: 'npm', args: ['run', 'build'] },
      { id: 'migrate', description: 'Migrate storage with the DATABASE_URL in your environment', tool: 'node', args: ['node_modules/mayura/lib/cli/dist/bin.js', 'migrate', '--app', project.app] },
    );
    steps.push({ id: 'deploy', description: containers ? 'Build and push the images, then deploy the Worker and its containers' : 'Bundle and deploy the Worker', tool: 'wrangler',
      args: ['deploy', '--config', 'wrangler.jsonc'] });
    return steps;
  },
});

export default cloudflareTarget;
