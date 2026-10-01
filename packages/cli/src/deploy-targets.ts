import { MayuraError, type JsonObject, type JsonValue } from '@mayura/core';
import { defineDeployTarget, type DeployProject, type DeployRelease, type DeployStep, type DeployTarget } from './deploy.js';

// The container targets every Mayura app can use without a platform package: an image, Docker Compose and Kubernetes.

const nodeImage = 'node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5';
const postgresImage = 'postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995';
/** In the Kubernetes manifests: the image and the release, replaced when a release is planned. */
export const IMAGE_PLACEHOLDER = 'mayura-app-image';
export const RELEASE_PLACEHOLDER = 'mayura-release';

function settingsObject(value: JsonValue | undefined, target: string, allowed: readonly string[]): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new MayuraError('INVALID_CONFIG', `targets.${target} allows only ${allowed.length ? allowed.join(', ') : 'no settings'}.`);
  }
  return value;
}
function needImage(release: DeployRelease, target: string): string {
  if (release.image === undefined) throw new MayuraError('INVALID_CONFIG', `The ${target} target pushes an image: set "image" in mayura.deploy.json.`);
  return release.image;
}

export function dockerfile(project: DeployProject): string {
  return `# One image for every role; the command chooses serve, worker or migrate.
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
USER 65532:65532
ENV NODE_ENV=production MAYURA_ENV=production
EXPOSE ${project.port} ${project.probePort}
ENTRYPOINT ["node", "node_modules/mayura/lib/cli/dist/bin.js"]
CMD ["serve", "--app", "${project.app}"]
`;
}
export const dockerignore = 'node_modules\ndist\n.data\n.env\n.env.*\n*.sqlite*\n.git\n';

/** Build and push the release's image: the first steps of every target that runs it somewhere else. */
export function imageSteps(release: DeployRelease, target: string): DeployStep[] {
  const image = needImage(release, target);
  return [
    { id: 'build-image', description: `Build ${image}`, tool: 'docker', args: ['build', '--tag', image, '.'] },
    { id: 'push-image', description: `Push ${image}`, tool: 'docker', args: ['push', image] },
  ];
}

export const dockerTarget = defineDeployTarget<Record<string, never>>({
  id: 'docker', description: 'Build the application image and push it to its registry.', tools: ['docker'],
  settings: value => { settingsObject(value, 'docker', []); return {}; },
  files: ({ project }) => ({ Dockerfile: dockerfile(project), '.dockerignore': dockerignore }),
  plan: ({ release }) => imageSteps(release, 'docker'),
});

function composeFile(project: DeployProject): string {
  const database = `postgres://app:\${POSTGRES_PASSWORD}@postgres:5432/app`;
  // BusyBox wget is in the Alpine Node image; it exits non-zero unless /readyz answers 2xx.
  const probe = (portNumber: number) => `["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:${portNumber}/readyz"]`;
  return `# Production-shaped stack: PostgreSQL, a one-shot migration, the server and a worker, from one image.
# Put a TLS proxy in front of \`server\`; it must forward to port ${project.port} with the public origin's Host.
#   cp .env.example .env   # set POSTGRES_PASSWORD and the app's variables
services:
  postgres:
    image: ${postgresImage}
    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: "\${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}", POSTGRES_DB: app }
    volumes: [postgres-data:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U app -d app"], interval: 2s, timeout: 5s, retries: 30 }
  migrate:
    build: .
    command: ["migrate", "--app", "${project.app}"]
    env_file: .env
    environment: { DATABASE_URL: "${database}" }
    depends_on: { postgres: { condition: service_healthy } }
  server:
    build: .
    command: ["serve", "--app", "${project.app}"]
    env_file: .env
    environment: { DATABASE_URL: "${database}" }
    ports: ["${project.port}:${project.port}"]
    depends_on: { migrate: { condition: service_completed_successfully } }
    healthcheck: { test: ${probe(project.port)}, interval: 5s, timeout: 5s, retries: 30 }
  worker:
    build: .
    command: ["worker", "--app", "${project.app}", "--probe-host", "0.0.0.0", "--probe-port", "${project.probePort}"]
    env_file: .env
    environment: { DATABASE_URL: "${database}" }
    depends_on: { migrate: { condition: service_completed_successfully } }
    healthcheck: { test: ${probe(project.probePort)}, interval: 5s, timeout: 5s, retries: 30 }
volumes:
  postgres-data:
`;
}

export const composeTarget = defineDeployTarget<{ readonly projectName?: string }>({
  id: 'compose', description: 'Run PostgreSQL, the migration, the server and a worker with Docker Compose.', tools: ['docker'],
  settings: value => {
    const settings = settingsObject(value, 'compose', ['projectName']); const projectName = settings['projectName'];
    if (projectName !== undefined && (typeof projectName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(projectName))) throw new MayuraError('INVALID_CONFIG', 'targets.compose.projectName must be a Compose project name.');
    return projectName === undefined ? {} : { projectName };
  },
  files: ({ project }) => ({ Dockerfile: dockerfile(project), '.dockerignore': dockerignore, 'compose.yaml': composeFile(project) }),
  plan: ({ project, settings }) => {
    const compose = ['compose', '--project-name', settings.projectName ?? project.name];
    return [
      { id: 'build', description: 'Build the image', tool: 'docker', args: [...compose, 'build'] },
      { id: 'migrate', description: 'Migrate storage, once, before the new release serves', tool: 'docker', args: [...compose, 'run', '--rm', 'migrate'] },
      { id: 'start', description: 'Start or update the server and the worker, and wait until they are healthy', tool: 'docker', args: [...compose, 'up', '--detach', '--wait', 'server', 'worker'] },
    ];
  },
});

interface KubernetesSettings { readonly namespace: string; readonly context?: string; readonly secret: string; readonly serverReplicas: number; readonly workerReplicas: number; readonly timeoutSeconds: number }

const dns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
function count(value: JsonValue | undefined, fallback: number, max: number, what: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new MayuraError('INVALID_CONFIG', `targets.kubernetes.${what} must be a whole number from 1 to ${max}.`);
  return value;
}

function migrationJob(project: DeployProject, settings: KubernetesSettings): string {
  return `# One Job per release, run to completion before the rollout. \`mayura deploy\` replaces ${IMAGE_PLACEHOLDER} and
# ${RELEASE_PLACEHOLDER} with the release's image and tag; keep both when you edit this file.
apiVersion: batch/v1
kind: Job
metadata:
  name: ${project.name}-migrate-${RELEASE_PLACEHOLDER}
  labels: { app.kubernetes.io/name: ${project.name}, app.kubernetes.io/component: migrate }
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      securityContext: { runAsNonRoot: true, runAsUser: 65532 }
      containers:
        - name: migrate
          image: ${IMAGE_PLACEHOLDER}
          args: ["migrate", "--app", "${project.app}"]
          envFrom: [{ secretRef: { name: ${settings.secret} } }]
`;
}
function serverManifest(project: DeployProject, settings: KubernetesSettings): string {
  return `# The HTTP server and its Service. \`mayura deploy\` replaces ${IMAGE_PLACEHOLDER} with the release's image.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${project.name}-server
  labels: { app.kubernetes.io/name: ${project.name}, app.kubernetes.io/component: server }
spec:
  replicas: ${settings.serverReplicas}
  selector: { matchLabels: { app.kubernetes.io/name: ${project.name}, app.kubernetes.io/component: server } }
  template:
    metadata:
      labels: { app.kubernetes.io/name: ${project.name}, app.kubernetes.io/component: server }
    spec:
      terminationGracePeriodSeconds: 45
      securityContext: { runAsNonRoot: true, runAsUser: 65532 }
      containers:
        - name: server
          image: ${IMAGE_PLACEHOLDER}
          args: ["serve", "--app", "${project.app}"]
          envFrom: [{ secretRef: { name: ${settings.secret} } }]
          ports: [{ containerPort: ${project.port} }]
          readinessProbe: { httpGet: { path: /readyz, port: ${project.port} }, periodSeconds: 5 }
          livenessProbe: { httpGet: { path: /livez, port: ${project.port} }, periodSeconds: 10 }
---
apiVersion: v1
kind: Service
metadata:
  name: ${project.name}-server
  labels: { app.kubernetes.io/name: ${project.name}, app.kubernetes.io/component: server }
spec:
  selector: { app.kubernetes.io/name: ${project.name}, app.kubernetes.io/component: server }
  ports: [{ port: 80, targetPort: ${project.port} }]
`;
}
function workerManifest(project: DeployProject, settings: KubernetesSettings): string {
  return `# Workflow workers: one leads, the rest stand by. \`mayura deploy\` replaces ${IMAGE_PLACEHOLDER} with the release's image.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${project.name}-worker
  labels: { app.kubernetes.io/name: ${project.name}, app.kubernetes.io/component: worker }
spec:
  replicas: ${settings.workerReplicas}
  selector: { matchLabels: { app.kubernetes.io/name: ${project.name}, app.kubernetes.io/component: worker } }
  template:
    metadata:
      labels: { app.kubernetes.io/name: ${project.name}, app.kubernetes.io/component: worker }
    spec:
      terminationGracePeriodSeconds: 45
      securityContext: { runAsNonRoot: true, runAsUser: 65532 }
      containers:
        - name: worker
          image: ${IMAGE_PLACEHOLDER}
          args: ["worker", "--app", "${project.app}", "--probe-host", "0.0.0.0", "--probe-port", "${project.probePort}"]
          envFrom: [{ secretRef: { name: ${settings.secret} } }]
          env: [{ name: MAYURA_WORKER_ID, valueFrom: { fieldRef: { fieldPath: metadata.name } } }]
          readinessProbe: { httpGet: { path: /readyz, port: ${project.probePort} }, periodSeconds: 5 }
          livenessProbe: { httpGet: { path: /livez, port: ${project.probePort} }, periodSeconds: 10 }
`;
}

const manifests = { job: 'deploy/kubernetes/migrate-job.yaml', server: 'deploy/kubernetes/server.yaml', worker: 'deploy/kubernetes/worker.yaml' } as const;

/**
 * A release tag as it may appear in a Kubernetes name: lowercase, `.` and `_` as `-`, at most 13 characters, so that
 * `<name>-migrate-<slug>` stays within Kubernetes' 63 (names are at most 40).
 */
export function releaseSlug(tag: string): string {
  const slug = tag.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 13).replace(/-+$/u, '');
  return slug || 'release';
}
function render(manifest: string, path: string, image: string, slug: string): string {
  if (!manifest.includes(IMAGE_PLACEHOLDER)) throw new MayuraError('INVALID_CONFIG', `${path} must keep the image placeholder ${IMAGE_PLACEHOLDER}.`);
  return manifest.replaceAll(IMAGE_PLACEHOLDER, image).replaceAll(RELEASE_PLACEHOLDER, slug);
}

export const kubernetesTarget = defineDeployTarget<KubernetesSettings>({
  id: 'kubernetes', description: 'Build and push the image, run the migration Job, then roll out the server and worker with kubectl.', tools: ['docker', 'kubectl'],
  settings: value => {
    const settings = settingsObject(value, 'kubernetes', ['namespace', 'context', 'secret', 'serverReplicas', 'workerReplicas', 'timeoutSeconds']);
    const namespace = settings['namespace'] ?? 'default'; const context = settings['context']; const secret = settings['secret'];
    if (typeof namespace !== 'string' || !dns.test(namespace)) throw new MayuraError('INVALID_CONFIG', 'targets.kubernetes.namespace must be a Kubernetes namespace name.');
    if (context !== undefined && (typeof context !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,252}$/u.test(context))) throw new MayuraError('INVALID_CONFIG', 'targets.kubernetes.context must be a kubeconfig context name.');
    if (secret !== undefined && (typeof secret !== 'string' || !dns.test(secret))) throw new MayuraError('INVALID_CONFIG', 'targets.kubernetes.secret must be a Secret name.');
    return { namespace, ...(context === undefined ? {} : { context: context as string }), secret: (secret as string | undefined) ?? '',
      serverReplicas: count(settings['serverReplicas'], 2, 100, 'serverReplicas'), workerReplicas: count(settings['workerReplicas'], 2, 100, 'workerReplicas'),
      timeoutSeconds: count(settings['timeoutSeconds'], 600, 3_600, 'timeoutSeconds') };
  },
  files: ({ project, settings }) => {
    const resolved = { ...settings, secret: settings.secret || `${project.name}-env` };
    return { Dockerfile: dockerfile(project), '.dockerignore': dockerignore,
      [manifests.job]: migrationJob(project, resolved), [manifests.server]: serverManifest(project, resolved), [manifests.worker]: workerManifest(project, resolved) };
  },
  plan: async ({ project, settings, release, readFile }) => {
    const image = needImage(release, 'kubernetes'); const slug = releaseSlug(release.tag);
    const kubectl = [...(settings.context === undefined ? [] : ['--context', settings.context]), '--namespace', settings.namespace];
    const job = render(await readFile(manifests.job), manifests.job, image, slug);
    const workloads = `${render(await readFile(manifests.server), manifests.server, image, slug)}---\n${render(await readFile(manifests.worker), manifests.worker, image, slug)}`;
    const jobName = `${project.name}-migrate-${slug}`; const timeout = `--timeout=${settings.timeoutSeconds}s`;
    return [
      ...imageSteps(release, 'kubernetes'),
      { id: 'migrate', description: `Start the migration Job ${jobName}`, tool: 'kubectl', args: [...kubectl, 'apply', '-f', '-'], stdin: job },
      // A Job's first condition appears only once it has an outcome (SuccessCriteriaMet or Complete, FailureTarget or
      // Failed), so this returns as soon as the migration succeeds or fails, instead of waiting out the timeout.
      { id: 'migrate-finish', description: 'Wait for the migration to finish', tool: 'kubectl', args: [...kubectl, 'wait', '--for=jsonpath={.status.conditions[0].type}', timeout, `job/${jobName}`] },
      { id: 'migrate-logs', description: 'Show what the migration printed', tool: 'kubectl', args: [...kubectl, 'logs', `job/${jobName}`] },
      { id: 'migrate-wait', description: 'Check that the migration succeeded', tool: 'kubectl', args: [...kubectl, 'wait', '--for=condition=complete', '--timeout=30s', `job/${jobName}`] },
      { id: 'roll-out', description: 'Apply the server and worker at the new image', tool: 'kubectl', args: [...kubectl, 'apply', '-f', '-'], stdin: workloads },
      { id: 'server-ready', description: 'Wait for the server rollout', tool: 'kubectl', args: [...kubectl, 'rollout', 'status', `deployment/${project.name}-server`, timeout] },
      { id: 'worker-ready', description: 'Wait for the worker rollout', tool: 'kubectl', args: [...kubectl, 'rollout', 'status', `deployment/${project.name}-worker`, timeout] },
    ];
  },
});

/** The targets every project has. Others come from `@mayurajs/deploy-*` packages. */
export const builtInDeployTargets: Readonly<Record<string, DeployTarget>> = Object.freeze({
  docker: dockerTarget as unknown as DeployTarget, compose: composeTarget as unknown as DeployTarget, kubernetes: kubernetesTarget as unknown as DeployTarget,
});
