import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { defineDeployTarget, dockerfile, dockerignore, type DeployProject } from 'mayura/cli/deploy';

/** When Render deploys on its own: never (releases go through `mayura deploy`), on each commit, or once checks pass. */
export type RenderAutoDeploy = 'off' | 'commit' | 'checksPass';

export interface RenderSettings {
  /** Render region: `oregon` by default. */
  readonly region: string;
  /** Instance type of the server and the worker (`starter` by default; pre-deploy commands need a paid one). */
  readonly plan: string;
  /** PostgreSQL instance type: `basic-256mb` by default. */
  readonly databasePlan: string;
  readonly autoDeploy: RenderAutoDeploy;
  /** The services' ids (`srv-…`), from the dashboard once the Blueprint has created them; releases need both. */
  readonly serverServiceId?: string;
  readonly workerServiceId?: string;
}

const allowed = ['region', 'plan', 'databasePlan', 'autoDeploy', 'serverServiceId', 'workerServiceId'];
const slug = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const serviceId = /^srv-[a-z0-9]{8,64}$/u;
const cli = 'node node_modules/mayura/lib/cli/dist/bin.js';

function settings(value: JsonValue | undefined): RenderSettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) {
    throw new MayuraError('INVALID_CONFIG', `targets.render allows only ${allowed.join(', ')}.`);
  }
  const region = raw['region'] ?? 'oregon'; const plan = raw['plan'] ?? 'starter'; const databasePlan = raw['databasePlan'] ?? 'basic-256mb'; const autoDeploy = raw['autoDeploy'] ?? 'off';
  for (const [name, item] of [['region', region], ['plan', plan], ['databasePlan', databasePlan]] as const) {
    if (typeof item !== 'string' || !slug.test(item)) throw new MayuraError('INVALID_CONFIG', `targets.render.${name} must be a Render ${name === 'region' ? 'region' : 'instance type'}, such as ${name === 'region' ? 'oregon' : name === 'plan' ? 'starter' : 'basic-256mb'}.`);
  }
  if (autoDeploy !== 'off' && autoDeploy !== 'commit' && autoDeploy !== 'checksPass') throw new MayuraError('INVALID_CONFIG', 'targets.render.autoDeploy must be off, commit or checksPass.');
  const ids: Record<string, string> = {};
  for (const name of ['serverServiceId', 'workerServiceId'] as const) {
    const item = raw[name]; if (item === undefined) continue;
    if (typeof item !== 'string' || !serviceId.test(item)) throw new MayuraError('INVALID_CONFIG', `targets.render.${name} must be a Render service id (srv-…).`);
    ids[name] = item;
  }
  if (ids['serverServiceId'] !== undefined && ids['serverServiceId'] === ids['workerServiceId']) throw new MayuraError('INVALID_CONFIG', 'The server and the worker are two Render services with two ids.');
  return { region: region as string, plan: plan as string, databasePlan: databasePlan as string, autoDeploy, ...ids };
}

function blueprint(project: DeployProject, render: RenderSettings): string {
  const app = `--app ${project.app}`;
  // Declared without values: Render asks for each when the Blueprint is created, and they never reach the repository.
  const secrets = project.env.filter(name => name !== 'DATABASE_URL').map(name => `      - key: ${name}\n        sync: false`).join('\n');
  const env = (extra: string) => `    envVars:\n      - key: DATABASE_URL\n        fromDatabase:\n          name: ${project.name}-db\n          property: connectionString\n${extra}${secrets ? `${secrets}\n` : ''}`;
  const common = (role: 'server' | 'worker') => `    runtime: docker
    region: ${render.region}
    plan: ${render.plan}
    dockerfilePath: ./deploy/render/Dockerfile
    dockerContext: .
    # Full commands: this image has no entry point, so they run as written.
    preDeployCommand: ${cli} migrate ${app}
    autoDeployTrigger: "${render.autoDeploy}"
${env(role === 'server' ? `      - key: PORT\n        value: "${project.port}"\n` : '')}`;
  return `# Render Blueprint: the server as a web service, a background worker, and PostgreSQL. Both services migrate
# storage before they go live (migrations take a lock). Create it once from the dashboard (New > Blueprint), then set
# targets.render.serverServiceId and workerServiceId in mayura.deploy.json to the services' ids.
services:
  - type: web
    name: ${project.name}-server
${common('server')}    dockerCommand: ${cli} serve ${app}
    healthCheckPath: /readyz
  - type: worker
    name: ${project.name}-worker
${common('worker')}    dockerCommand: ${cli} worker ${app} --probe-host 0.0.0.0 --probe-port ${project.probePort}
databases:
  - name: ${project.name}-db
    region: ${render.region}
    plan: ${render.databasePlan}
`;
}

/** Deploys to Render: a Blueprint with a web service, a background worker and PostgreSQL, released with the Render CLI. */
export const renderTarget = defineDeployTarget<RenderSettings>({
  id: 'render', description: 'Deploy to Render: a Blueprint with a web service, a background worker and PostgreSQL, released with the Render CLI.', tools: ['render'],
  settings,
  files: ({ project, settings: render }) => ({
    '.dockerignore': dockerignore, 'deploy/render/Dockerfile': dockerfile(project, { entrypoint: false }), 'render.yaml': blueprint(project, render),
  }),
  plan: async ({ settings: render, readFile }) => {
    await readFile('render.yaml'); await readFile('deploy/render/Dockerfile');
    if (render.serverServiceId === undefined || render.workerServiceId === undefined) {
      throw new MayuraError('INVALID_CONFIG', 'Set targets.render.serverServiceId and workerServiceId (srv-…) once the Blueprint has created the services.');
    }
    const deploy = (id: string) => ['deploys', 'create', id, '--wait', '--confirm', '--output', 'text'];
    return [
      { id: 'validate', description: 'Validate render.yaml with Render', tool: 'render', args: ['blueprints', 'validate', 'render.yaml'] },
      { id: 'deploy-server', description: 'Deploy the server and wait for it (its migration runs first)', tool: 'render', args: deploy(render.serverServiceId) },
      { id: 'deploy-worker', description: 'Deploy the worker and wait for it', tool: 'render', args: deploy(render.workerServiceId) },
    ];
  },
});

export default renderTarget;
