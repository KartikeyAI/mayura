import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { defineDeployTarget, dockerfile, dockerignore, type DeployProject } from 'mayura/cli/deploy';

export interface DigitalOceanSettings {
  /** The app's id, from `doctl apps create --spec .do/app.yaml` or the control panel; a release needs it. */
  readonly appId?: string;
  /** The image tag the app runs: each release pushes to it, then deploys. `release` by default. */
  readonly channel: string;
  /** The app's region slug: `nyc` by default. */
  readonly region: string;
  /** Instance size and the server's instance count. */
  readonly instanceSize: string;
  readonly serverInstances: number;
  /** A managed PostgreSQL cluster to attach; a development database when absent. */
  readonly databaseCluster?: string;
  /** How long a release waits for the deployment, in seconds (1800 by default). */
  readonly timeoutSeconds: number;
}

const allowed = ['appId', 'channel', 'region', 'instanceSize', 'serverInstances', 'databaseCluster', 'timeoutSeconds'];
const fail = (message: string): never => { throw new MayuraError('INVALID_CONFIG', message); };
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const cli = 'node node_modules/mayura/lib/cli/dist/bin.js';

function settings(value: JsonValue | undefined): DigitalOceanSettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return fail(`targets.digitalocean allows only ${allowed.join(', ')}.`);
  const appId = raw['appId']; const channel = raw['channel'] ?? 'release'; const region = raw['region'] ?? 'nyc'; const instanceSize = raw['instanceSize'] ?? 'apps-s-1vcpu-1gb';
  const cluster = raw['databaseCluster']; const instances = raw['serverInstances'] ?? 1; const timeout = raw['timeoutSeconds'] ?? 1_800;
  if (appId !== undefined && (typeof appId !== 'string' || !new RegExp(`^${uuid}$`, 'u').test(appId))) fail('targets.digitalocean.appId must be the app\'s id.');
  if (typeof channel !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(channel)) fail('targets.digitalocean.channel must be an image tag, such as release.');
  if (typeof region !== 'string' || !/^[a-z]{3}$/u.test(region)) fail('targets.digitalocean.region must be an App Platform region slug, such as nyc or fra.');
  if (typeof instanceSize !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(instanceSize)) fail('targets.digitalocean.instanceSize must be an instance size slug.');
  if (cluster !== undefined && (typeof cluster !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(cluster))) fail('targets.digitalocean.databaseCluster must be a database cluster name.');
  if (typeof instances !== 'number' || !Number.isSafeInteger(instances) || instances < 1 || instances > 250) fail('targets.digitalocean.serverInstances must be from 1 to 250.');
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 60 || timeout > 3_600) fail('targets.digitalocean.timeoutSeconds must be from 60 to 3600.');
  return { ...(appId === undefined ? {} : { appId: appId as string }), channel: channel as string, region: region as string, instanceSize: instanceSize as string,
    serverInstances: instances as number, ...(cluster === undefined ? {} : { databaseCluster: cluster as string }), timeoutSeconds: timeout as number };
}

/** `registry.digitalocean.com/<registry>/<repository>`: App Platform pulls DOCR images by repository. */
function docr(image: string | undefined): string | undefined {
  const match = /^registry\.digitalocean\.com\/[a-z0-9-]+\/([a-z0-9][a-z0-9._/-]*)$/u.exec(image ?? '');
  return match?.[1];
}

function appSpec(project: DeployProject, ocean: DigitalOceanSettings): string {
  const repository = docr(project.image) ?? `${project.name}`;
  const image = `    image:\n      registry_type: DOCR\n      repository: ${repository}\n      tag: ${ocean.channel}\n`;
  const component = () => `${image}    instance_size_slug: ${ocean.instanceSize}\n    envs:\n      - key: DATABASE_URL\n        scope: RUN_TIME\n        value: \${db.DATABASE_URL}\n`;
  return `# DigitalOcean App Platform: the server as a service, a worker, the migration as a pre-deploy job, and PostgreSQL.
# Create the app once with: doctl apps create --spec .do/app.yaml, then set targets.digitalocean.appId. Add the app's
# secret variables in the control panel: releases deploy the image on the "${ocean.channel}" tag and never replace this
# spec, so they are kept. Full commands: the image has no entry point.
name: ${project.name}
region: ${ocean.region}
services:
  - name: server
${component()}    run_command: ${cli} serve --app ${project.app}
    http_port: ${project.port}
    instance_count: ${ocean.serverInstances}
    health_check:
      http_path: /readyz
      initial_delay_seconds: 10
workers:
  - name: worker
${component()}    run_command: ${cli} worker --app ${project.app} --probe-host 0.0.0.0 --probe-port ${project.probePort}
jobs:
  - name: migrate
    kind: PRE_DEPLOY
${component()}    run_command: ${cli} migrate --app ${project.app}
databases:
  - name: db
    engine: PG
${ocean.databaseCluster === undefined ? '    production: false\n' : `    production: true\n    cluster_name: ${ocean.databaseCluster}\n`}`;
}

/** Deploys to DigitalOcean App Platform: pushes the release to the app's image tag, then deploys and waits for it. */
export const digitalOceanTarget = defineDeployTarget<DigitalOceanSettings>({
  id: 'digitalocean', description: 'Deploy to DigitalOcean App Platform: push the image to the app\'s tag, then deploy and wait; a pre-deploy job migrates.', tools: ['doctl', 'docker'],
  settings,
  files: ({ project, settings: ocean }) => ({ '.dockerignore': dockerignore, 'deploy/digitalocean/Dockerfile': dockerfile(project, { entrypoint: false }), '.do/app.yaml': appSpec(project, ocean) }),
  plan: async ({ settings: ocean, release, readFile }) => {
    await readFile('deploy/digitalocean/Dockerfile'); await readFile('.do/app.yaml');
    if (ocean.appId === undefined) return fail('Set targets.digitalocean.appId once the app exists (doctl apps create --spec .do/app.yaml).');
    if (release.image === undefined || docr(release.image.slice(0, release.image.lastIndexOf(':'))) === undefined) {
      return fail('App Platform pulls from DigitalOcean Container Registry: set "image" to registry.digitalocean.com/<registry>/<repository>.');
    }
    const repository = release.image.slice(0, release.image.lastIndexOf(':')); const channel = `${repository}:${ocean.channel}`;
    return [
      { id: 'check-app', description: 'Check that doctl can reach the app', tool: 'doctl', args: ['apps', 'get', ocean.appId, '--format', 'ID', '--no-header'], output: { match: ocean.appId } },
      { id: 'build-image', description: `Build ${release.image}`, tool: 'docker', args: ['build', '--file', 'deploy/digitalocean/Dockerfile', '--tag', release.image, '--tag', channel, '.'] },
      { id: 'push-image', description: `Push ${release.image}`, tool: 'docker', args: ['push', release.image] },
      { id: 'push-channel', description: `Point the app's tag ${ocean.channel} at it`, tool: 'docker', args: ['push', channel] },
      { id: 'deploy', description: 'Start a deployment of the app', tool: 'doctl', args: ['apps', 'create-deployment', ocean.appId, '--format', 'ID', '--no-header'], output: { match: uuid, as: 'deployment' } },
      // The pre-deploy job migrates first; a failed migration ends the deployment in ERROR and nothing new goes live.
      { id: 'deploy-wait', description: 'Wait until the deployment is live', tool: 'doctl', args: ['apps', 'get-deployment', ocean.appId, '{{deployment}}', '--format', 'Phase', '--no-header'],
        output: { match: 'ACTIVE', retry: { while: 'PENDING_BUILD|BUILDING|PENDING_DEPLOY|DEPLOYING|UNKNOWN', attempts: Math.ceil(ocean.timeoutSeconds / 10), intervalSeconds: 10 } } },
    ];
  },
});

export default digitalOceanTarget;
