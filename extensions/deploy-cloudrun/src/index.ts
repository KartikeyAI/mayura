import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { defineDeployTarget, dockerfile, dockerignore, imageSteps, type DeployProject, type DeployStep } from 'mayura/cli/deploy';

/** Where a release's image is built: by Cloud Build, or by your local Docker and pushed. */
export type CloudRunBuild = 'cloud-build' | 'local';

export interface CloudRunSettings {
  /** The Google Cloud project id; a release needs it. */
  readonly project?: string;
  /** The Cloud Run region, such as `us-central1`. */
  readonly region: string;
  readonly build: CloudRunBuild;
  /**
   * Environment variables taken from Secret Manager, as `NAME: 'secret:version'`. By default `DATABASE_URL` and every
   * name in `env` come from a secret of the same name, at `latest`.
   */
  readonly secrets: Readonly<Record<string, string>>;
  /** A Cloud SQL instance (`project:region:instance`) to connect over the Cloud SQL connector. */
  readonly cloudSqlInstance?: string;
  /** The service account the services and the migration job run as. */
  readonly serviceAccount?: string;
  /** Whether anyone may call the server (it authenticates requests itself); `true` by default. */
  readonly public: boolean;
  /** Instances kept warm: the server's minimum (1) and the worker's count (1). */
  readonly serverMinInstances: number;
  readonly workerInstances: number;
}

const allowed = ['project', 'region', 'build', 'secrets', 'cloudSqlInstance', 'serviceAccount', 'public', 'serverMinInstances', 'workerInstances'];
const projectId = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const region = /^[a-z]+-[a-z]+\d$/u;
const envName = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const secretRef = /^[A-Za-z0-9_-]{1,255}:(?:latest|\d{1,10})$/u;

function settings(value: JsonValue | undefined, project: DeployProject): CloudRunSettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) throw new MayuraError('INVALID_CONFIG', `targets.cloudrun allows only ${allowed.join(', ')}.`);
  const id = raw['project']; const where = raw['region'] ?? 'us-central1'; const build = raw['build'] ?? 'cloud-build';
  if (id !== undefined && (typeof id !== 'string' || !projectId.test(id))) throw new MayuraError('INVALID_CONFIG', 'targets.cloudrun.project must be a Google Cloud project id.');
  if (typeof where !== 'string' || !region.test(where)) throw new MayuraError('INVALID_CONFIG', 'targets.cloudrun.region must be a Cloud Run region, such as us-central1.');
  if (build !== 'cloud-build' && build !== 'local') throw new MayuraError('INVALID_CONFIG', 'targets.cloudrun.build must be cloud-build or local.');
  const secrets: Record<string, string> = Object.fromEntries(['DATABASE_URL', ...project.env].map(name => [name, `${name}:latest`]));
  const configured = raw['secrets'];
  if (configured !== undefined) {
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new MayuraError('INVALID_CONFIG', 'targets.cloudrun.secrets maps variable names to secret:version.');
    for (const [name, reference] of Object.entries(configured)) {
      if (!envName.test(name) || typeof reference !== 'string' || !secretRef.test(reference)) throw new MayuraError('INVALID_CONFIG', `targets.cloudrun.secrets.${name} must be a Secret Manager reference such as openai-key:latest.`);
      secrets[name] = reference;
    }
  }
  const instance = raw['cloudSqlInstance']; const account = raw['serviceAccount']; const isPublic = raw['public'] ?? true;
  if (instance !== undefined && (typeof instance !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z]+-[a-z]+\d:[a-z][a-z0-9-]{0,95}$/u.test(instance))) throw new MayuraError('INVALID_CONFIG', 'targets.cloudrun.cloudSqlInstance must be project:region:instance.');
  if (account !== undefined && (typeof account !== 'string' || !/^[a-z][a-z0-9-]{4,29}@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/u.test(account))) throw new MayuraError('INVALID_CONFIG', 'targets.cloudrun.serviceAccount must be a service account email.');
  if (typeof isPublic !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'targets.cloudrun.public must be true or false.');
  const count = (name: string, fallback: number): number => {
    const item = raw[name] ?? fallback;
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 || item > 100) throw new MayuraError('INVALID_CONFIG', `targets.cloudrun.${name} must be from 1 to 100.`);
    return item;
  };
  return { ...(id === undefined ? {} : { project: id as string }), region: where, build, secrets, ...(instance === undefined ? {} : { cloudSqlInstance: instance as string }),
    ...(account === undefined ? {} : { serviceAccount: account as string }), public: isPublic, serverMinInstances: count('serverMinInstances', 1), workerInstances: count('workerInstances', 1) };
}

/** Deploys to Google Cloud Run with gcloud: a migration job, then the server and an always-on worker as services. */
export const cloudRunTarget = defineDeployTarget<CloudRunSettings>({
  id: 'cloudrun', description: 'Deploy to Google Cloud Run with gcloud: a migration job, then the server and an always-on worker as services.', tools: ['gcloud', 'docker'],
  settings,
  files: ({ project }) => ({ Dockerfile: dockerfile(project), '.dockerignore': dockerignore }),
  plan: async ({ project, settings: run, release, readFile }) => {
    await readFile('Dockerfile');
    if (run.project === undefined) throw new MayuraError('INVALID_CONFIG', 'Set targets.cloudrun.project in mayura.deploy.json to the Google Cloud project id.');
    const gcp = run.project;
    if (release.image === undefined) throw new MayuraError('INVALID_CONFIG', 'Cloud Run deploys an image: set "image" in mayura.deploy.json to an Artifact Registry repository, such as us-central1-docker.pkg.dev/acme/apps/refunds.');
    const image = release.image; const where = ['--project', gcp, '--region', run.region];
    const shared = [
      `--image=${image}`, ...(Object.keys(run.secrets).length ? [`--set-secrets=${Object.entries(run.secrets).map(([name, reference]) => `${name}=${reference}`).join(',')}`] : []),
      ...(run.cloudSqlInstance === undefined ? [] : [`--set-cloudsql-instances=${run.cloudSqlInstance}`]), ...(run.serviceAccount === undefined ? [] : [`--service-account=${run.serviceAccount}`]),
    ];
    const probe = (port: number) => `--startup-probe=httpGet.path=/readyz,httpGet.port=${port},periodSeconds=5,failureThreshold=24`;
    const build: DeployStep[] = run.build === 'local' ? imageSteps(release, 'cloudrun')
      : [{ id: 'build-image', description: `Build ${image} with Cloud Build`, tool: 'gcloud', args: ['builds', 'submit', '--project', gcp, `--tag=${image}`, '--quiet', '.'] }];
    return [
      { id: 'check-project', description: `Check that gcloud can reach ${gcp}`, tool: 'gcloud', args: ['projects', 'describe', gcp, '--format=none'] },
      ...build,
      // One job, updated to the release's image and run to completion; a failure stops the release.
      { id: 'migrate', description: 'Run the migration job and wait for it', tool: 'gcloud',
        args: ['run', 'jobs', 'deploy', `${project.name}-migrate`, ...where, ...shared, `--args=migrate,--app,${project.app}`, '--max-retries=0', '--task-timeout=1800s', '--execute-now', '--wait', '--quiet'] },
      // CPU stays allocated and instances stay warm: agent runs continue after a response.
      { id: 'deploy-server', description: 'Deploy the server and wait until it is ready', tool: 'gcloud',
        args: ['run', 'deploy', `${project.name}-server`, ...where, ...shared, `--args=serve,--app,${project.app}`, `--port=${project.port}`, '--no-cpu-throttling',
          `--min-instances=${run.serverMinInstances}`, '--timeout=3600s', probe(project.port), run.public ? '--allow-unauthenticated' : '--no-allow-unauthenticated', '--quiet'] },
      // The worker serves only its probes: internal, never public, always running.
      { id: 'deploy-worker', description: 'Deploy the always-on worker and wait until it is ready', tool: 'gcloud',
        args: ['run', 'deploy', `${project.name}-worker`, ...where, ...shared, `--args=worker,--app,${project.app},--probe-host,0.0.0.0,--probe-port,${project.probePort}`,
          `--port=${project.probePort}`, '--no-cpu-throttling', `--min-instances=${run.workerInstances}`, `--max-instances=${run.workerInstances}`, '--ingress=internal',
          '--no-allow-unauthenticated', probe(project.probePort), '--quiet'] },
    ];
  },
});

export default cloudRunTarget;
