import { MayuraError, type JsonValue } from 'mayura';
import { defineDeployTarget, dockerfile, dockerignore, imageSteps, type DeployProject, type DeployStep } from 'mayura/cli/deploy';

/** How a release's image is built: by Fly's remote builders, by your local Docker, or pushed to your own registry first. */
export type FlyBuild = 'remote' | 'local' | 'image';

export interface FlySettings {
  /** The Fly app; `name` from mayura.deploy.json by default. Create it once with `fly apps create <app>`. */
  readonly app: string;
  /** The primary region, such as `iad` or `fra`. */
  readonly region: string;
  readonly build: FlyBuild;
  /** Each machine's size and memory: `shared-cpu-1x` and `512mb` by default. */
  readonly vmSize: string;
  readonly memory: string;
  /** How long `fly deploy` waits for machines to be healthy, in seconds. */
  readonly waitSeconds: number;
}

const allowed = ['app', 'region', 'build', 'vmSize', 'memory', 'waitSeconds'];

function settings(value: JsonValue | undefined, project: DeployProject): FlySettings {
  const raw = value ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) {
    throw new MayuraError('INVALID_CONFIG', `targets.fly allows only ${allowed.join(', ')}.`);
  }
  const app = raw['app'] ?? project.name; const region = raw['region'] ?? 'iad'; const build = raw['build'] ?? 'remote';
  const vmSize = raw['vmSize'] ?? 'shared-cpu-1x'; const memory = raw['memory'] ?? '512mb'; const waitSeconds = raw['waitSeconds'] ?? 600;
  if (typeof app !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(app)) throw new MayuraError('INVALID_CONFIG', 'targets.fly.app must be a Fly app name: lowercase letters, digits and hyphens.');
  if (typeof region !== 'string' || !/^[a-z]{3}$/u.test(region)) throw new MayuraError('INVALID_CONFIG', 'targets.fly.region must be a Fly region code, such as iad or fra.');
  if (build !== 'remote' && build !== 'local' && build !== 'image') throw new MayuraError('INVALID_CONFIG', 'targets.fly.build must be remote, local or image.');
  if (typeof vmSize !== 'string' || !/^[a-z0-9-]{1,32}$/u.test(vmSize)) throw new MayuraError('INVALID_CONFIG', 'targets.fly.vmSize must be a Fly machine size, such as shared-cpu-1x.');
  if (typeof memory !== 'string' || !/^\d{3,6}mb$|^\d{1,3}gb$/u.test(memory)) throw new MayuraError('INVALID_CONFIG', 'targets.fly.memory must be a size such as 512mb or 2gb.');
  if (typeof waitSeconds !== 'number' || !Number.isSafeInteger(waitSeconds) || waitSeconds < 30 || waitSeconds > 3_600) throw new MayuraError('INVALID_CONFIG', 'targets.fly.waitSeconds must be from 30 to 3600.');
  return { app, region, build, vmSize, memory, waitSeconds };
}

function flyToml(project: DeployProject, fly: FlySettings): string {
  const worker = `worker --app ${project.app} --probe-host 0.0.0.0 --probe-port ${project.probePort}`;
  return `# Fly.io: the server as the \`app\` process, a workflow worker, and the migration as the release command, which
# runs before each release and stops it when it fails. Machines never stop on their own: agent runs continue after a
# response, and workflows need a running worker. Secrets: fly secrets import < .env.production
app = "${fly.app}"
primary_region = "${fly.region}"
kill_signal = "SIGTERM"
kill_timeout = "45s"

[build]
  dockerfile = "Dockerfile"

[deploy]
  release_command = "migrate --app ${project.app}"
  strategy = "rolling"

[processes]
  app = "serve --app ${project.app}"
  worker = "${worker}"

[http_service]
  internal_port = ${project.port}
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

  [[http_service.checks]]
    grace_period = "10s"
    interval = "15s"
    timeout = "5s"
    method = "GET"
    path = "/readyz"

[checks.worker_ready]
  type = "http"
  port = ${project.probePort}
  path = "/readyz"
  interval = "15s"
  timeout = "5s"
  grace_period = "10s"
  processes = ["worker"]

[[vm]]
  size = "${fly.vmSize}"
  memory = "${fly.memory}"
`;
}

/** Deploys to Fly.io with flyctl: the server, a worker, and the migration as the release command. */
export const flyTarget = defineDeployTarget<FlySettings>({
  id: 'fly', description: 'Deploy to Fly.io with flyctl: server and worker processes, the migration as the release command.', tools: ['flyctl', 'docker'],
  settings,
  files: ({ project, settings: fly }) => ({ Dockerfile: dockerfile(project), '.dockerignore': dockerignore, 'fly.toml': flyToml(project, fly) }),
  plan: async ({ settings: fly, release, readFile }) => {
    const config = await readFile('fly.toml');
    if (!config.includes(`app = "${fly.app}"`)) throw new MayuraError('INVALID_CONFIG', `fly.toml names another app than ${fly.app}: run mayura deploy init --target fly again.`);
    const flyctl = ['--app', fly.app];
    const deploy = ['deploy', ...flyctl, '--config', 'fly.toml', '--strategy', 'rolling', '--wait-timeout', `${fly.waitSeconds}s`];
    const steps: DeployStep[] = [{ id: 'check-app', description: `Check that ${fly.app} exists and flyctl is logged in`, tool: 'flyctl', args: ['status', ...flyctl] }];
    if (fly.build === 'image') {
      const image = release.image ?? '';
      steps.push(...imageSteps(release, 'fly'), { id: 'deploy', description: `Release ${image} on Fly.io (the migration runs first)`, tool: 'flyctl', args: [...deploy, '--image', image] });
    } else {
      steps.push({ id: 'deploy', description: `Build ${fly.build === 'remote' ? 'on Fly.io' : 'locally'} and release ${release.tag} (the migration runs first)`, tool: 'flyctl',
        args: [...deploy, fly.build === 'remote' ? '--remote-only' : '--local-only', '--image-label', release.tag] });
    }
    return steps;
  },
});

export default flyTarget;
