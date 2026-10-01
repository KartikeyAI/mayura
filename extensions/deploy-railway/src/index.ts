import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { defineDeployTarget, dockerfile, dockerignore, type DeployProject } from 'mayura/cli/deploy';

export interface RailwaySettings {
  /** The Railway services that run the server and the worker; `<name>-server` and `<name>-worker` by default. */
  readonly serverService: string;
  readonly workerService: string;
  /** The Railway environment to deploy to; the linked one when absent. */
  readonly environment?: string;
}

const allowed = ['serverService', 'workerService', 'environment'];
const serviceName = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,62}$/u;
/** The CLI inside the image: Railway's start and pre-deploy commands replace the image's entry point. */
const mayura = 'node node_modules/mayura/lib/cli/dist/bin.js';

function settings(value: JsonValue | undefined, project: DeployProject): RailwaySettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) {
    throw new MayuraError('INVALID_CONFIG', `targets.railway allows only ${allowed.join(', ')}.`);
  }
  const serverService = raw['serverService'] ?? `${project.name}-server`; const workerService = raw['workerService'] ?? `${project.name}-worker`; const environment = raw['environment'];
  for (const [name, item] of [['serverService', serverService], ['workerService', workerService]] as const) {
    if (typeof item !== 'string' || !serviceName.test(item)) throw new MayuraError('INVALID_CONFIG', `targets.railway.${name} must be a Railway service name.`);
  }
  if (serverService === workerService) throw new MayuraError('INVALID_CONFIG', 'The server and the worker need two Railway services.');
  if (environment !== undefined && (typeof environment !== 'string' || !serviceName.test(environment))) throw new MayuraError('INVALID_CONFIG', 'targets.railway.environment must be a Railway environment name.');
  return { serverService: serverService as string, workerService: workerService as string, ...(environment === undefined ? {} : { environment: environment as string }) };
}

function serviceConfig(project: DeployProject, role: 'server' | 'worker'): string {
  const start = role === 'server' ? `${mayura} serve --app ${project.app}` : `${mayura} worker --app ${project.app} --probe-host 0.0.0.0 --probe-port ${project.probePort}`;
  return `${JSON.stringify({
    $schema: 'https://railway.com/railway.schema.json',
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      startCommand: start,
      // Both services migrate before they go live; migrations take a lock, so whichever runs first does the work.
      preDeployCommand: [`${mayura} migrate --app ${project.app}`],
      ...(role === 'server' ? { healthcheckPath: '/readyz', healthcheckTimeout: 300 } : {}),
      restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10,
    },
  }, null, 2)}\n`;
}

/** Deploys to Railway with its CLI: a server service and a worker service from one repository, each migrating first. */
export const railwayTarget = defineDeployTarget<RailwaySettings>({
  id: 'railway', description: 'Deploy to Railway with its CLI: a server service and a worker service, each migrating before it goes live.', tools: ['railway'],
  settings,
  files: ({ project }) => ({
    Dockerfile: dockerfile(project), '.dockerignore': dockerignore,
    'deploy/railway/server.json': serviceConfig(project, 'server'), 'deploy/railway/worker.json': serviceConfig(project, 'worker'),
  }),
  plan: async ({ settings: railway, release, readFile }) => {
    // The service files must exist; each Railway service names its own in its settings (Config-as-code path).
    await readFile('deploy/railway/server.json'); await readFile('deploy/railway/worker.json');
    const environment = railway.environment === undefined ? [] : ['--environment', railway.environment];
    const up = (service: string) => ['up', '--ci', '--service', service, ...environment, '--message', `mayura deploy ${release.tag}`];
    return [
      { id: 'check-project', description: 'Check that the Railway CLI is logged in and the directory is linked to a project', tool: 'railway', args: ['status'] },
      { id: 'deploy-server', description: `Build and release the server on ${railway.serverService} (its migration runs first)`, tool: 'railway', args: up(railway.serverService) },
      { id: 'deploy-worker', description: `Build and release the worker on ${railway.workerService}`, tool: 'railway', args: up(railway.workerService) },
    ];
  },
});

export default railwayTarget;
