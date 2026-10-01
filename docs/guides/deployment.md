---
title: "Deployment"
description: "Run a Mayura app in production: on containers, Kubernetes, managed platforms, virtual machines, serverless functions or inside an app you already run."
---

A production Mayura app is one compiled application module run in three roles from the same build:

- `mayura migrate` prepares storage, once per release, before anything new serves traffic.
- `mayura serve` runs the HTTP server: your agents' API, the operator API and, if you enable it, the
  [operator console](operator-console.md).
- `mayura worker` advances durable workflows: timers, retries, human waits and scheduled work. Run as many replicas as
  you like; one leader works at a time and a standby takes over if it dies.

All of them share one PostgreSQL database. The CLI owns the process lifecycle (signals, probes for workers, drain and
shutdown); your module owns everything else. Every starter project (see [mayura init](../cli/init.md)) ships this
setup ready to run, with a `Dockerfile` and `compose.yaml`.

```text
   clients ──HTTPS──▶ TLS proxy ──HTTP──▶ mayura serve (1..n)  ──┐
                                                                 ├──▶ PostgreSQL
                                          mayura worker (1..n) ──┘
                                          mayura migrate (once per release)
```

`mayura deploy` writes these files for Docker, Docker Compose and Kubernetes, then plans and runs each release
with the tools you already use: see [Deploy with mayura deploy](../cli/deploy.md).

## Choose a target

Every target runs the same three commands from the same build, against the same PostgreSQL database. They differ
only in how the processes are started and kept running. Mayura needs Node.js 22 or 24 (see
[Supported platforms](../project/support.md)).

| Target | Server | Worker | Migration |
|---|---|---|---|
| [Containers](#containers): Docker, Compose | a `serve` container | a `worker` container | a one-shot container |
| [Kubernetes](#kubernetes) | a Deployment and a Service | a Deployment | a Job before each rollout |
| [Managed containers](#managed-container-platforms): ECS on Fargate, Cloud Run, Azure Container Apps, Fly.io | a service | an always-on service | a one-off task or job |
| [Process platforms](#platforms-with-process-types): Render, Railway, Heroku | a web process | a worker process | the release or pre-deploy command |
| [Virtual machines](#virtual-machines) | a systemd service | a systemd service | a step in your deploy script |
| [Inside an existing app](#inside-an-existing-nodejs-app) | your framework's `/v1/*` route | `mayura worker` | `mayura migrate` |
| [Serverless functions](#serverless-functions): Vercel; AWS Lambda and Cloud Run (experimental) | a request-bound function | a scheduled one-shot function or job | a step in your pipeline |

On every target except serverless functions, two rules hold. The worker keeps running: a platform that scales it to
zero, or stops its CPU between requests, stops your workflows too. And the server keeps working after it responds,
because agent runs continue in the process that accepted them, so it needs CPU between requests as well. Serverless
functions work the other way: runs finish inside their request and workflows advance on a schedule; see
[Serverless functions](#serverless-functions). Edge runtimes are planned for 1.1.

## The application module

The module's default export says how to start each role. This one serves an agent and the workflow operator API,
runs a workflow worker, and reads all of its configuration from the environment:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { defineMayuraApplication } from 'mayura/cli';
import { listenProductionServer, type ServerIdentity } from 'mayura/server-node';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createPostgresStore } from 'mayura/storage-postgres';
import { createWorkflowCommandJournal, createWorkflowFleetControl, createWorkflowLeadership, createWorkflowOperatorTransports,
  createWorkflowWorker, lifecycleOperatorTarget } from 'mayura/workflows';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';
import { assistant } from './assistant.js'; // your agent
import { definitions } from './workflows.js'; // every workflow definition version that still has runs

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const scope = { principalId: 'orders-service', projectId: 'orders' };
const store = createPostgresStore({ connectionString: env('DATABASE_URL') });
const fleet = createWorkflowFleetControl({ store, scope });
const workflowOptions = { store, scope, permissions: { allow: ['tool:orders.refund'] }, policyVersion: '1', maxCostMicros: 0 };
let initialized: Promise<void> | undefined;
const ready = () => (initialized ??= store.initialize());

// Operators get 64-hex tokens; configuration holds only their SHA-256 digests.
const operatorDigests = env('MAYURA_OPERATOR_TOKEN_SHA256').split(',');
async function authenticate({ token }: { readonly token: string }): Promise<ServerIdentity | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const supplied = createHash('sha256').update(token).digest();
  let matched = false; // compare against every digest, so timing does not reveal which one matched
  for (const digest of operatorDigests) matched = timingSafeEqual(supplied, Buffer.from(digest, 'hex')) || matched;
  if (!matched) return null;
  return { scope, agentIds: [assistant.id], expiresAtMs: Date.now() + 60_000,
    capabilities: ['runs:read', 'operations:read', 'workflows:read', 'workflows:control'] };
}

export default defineMayuraApplication({
  async server() {
    await ready();
    const runtime = createWorkflowLifecycleFleetRuntime(workflowOptions);
    const operator = createWorkflowOperatorTransports({ store, scope, fleet, journal: createWorkflowCommandJournal({ store, scope }),
      targets: [lifecycleOperatorTarget({ runtime, store, scope, definitions })] });
    return listenProductionServer({
      agents: [{ agent: assistant, permissions: { allow: ['model:openai.responses'] }, limits: { maxCostMicros: 200_000 } }],
      authenticate,
      // Every server replica can read, stream and cancel every agent run, and claims submission keys durably.
      runRecords: createAggregateRunRecords(store),
      inspector: true,
      ...operator,
      publicOrigin: env('MAYURA_PUBLIC_ORIGIN'),
      hostname: process.env['MAYURA_BIND'] ?? '0.0.0.0',
      port: Number(process.env['PORT'] ?? 8080),
      tls: { terminatedBy: 'proxy' },
      readiness: async () => { await store.read('readiness', 'probe'); return true; },
    });
  },
  async worker() {
    await ready();
    const host = createWorkflowLifecycleHost({ ...workflowOptions, definitions, hold: fleet });
    const leadership = createWorkflowLeadership({ store, scope, role: 'workflows',
      holderId: process.env['MAYURA_WORKER_ID'] ?? `${hostname()}-${process.pid}` });
    return createWorkflowWorker({ units: [host], leadership });
  },
  // Storage schema version 1 is the baseline. Later releases add explicit migrations here.
  async migrate() { await ready(); return { schemaVersion: 1 }; },
  async shutdown() { await store.close(); },
});
```

- `server()` returns a running server with `isAccepting()` and `close()`; `listenProductionServer` gives you one.
- `worker()` returns a worker with `start()`, `isReady()` and `drain()`; `createWorkflowWorker` gives you one. Don't
  start it yourself: the CLI calls `start()`.
- `migrate()` returns any JSON report, which the CLI prints.
- `shutdown()` runs after the server has closed or the worker has drained. Close storage here.

The module must be a compiled `.js` or `.mjs` file. Real apps usually split it into files as the starters do
(`config.ts`, `services.ts`, `server.ts`, `worker.ts`, `app.ts`). For your app's own user authentication, see
[Server and client](server-and-client.md).

## Run the three commands

After building (`tsc`), run them from the project directory:

```bash
mayura migrate --app dist/app.js
mayura serve --app dist/app.js
mayura worker --app dist/app.js --probe-host 0.0.0.0 --probe-port 9090
```

Run `migrate` to completion before starting new servers and workers. Run the server and the worker as separate
processes (or containers); both read the same environment. See [CLI: serve, worker and migrate](../cli/run.md) for
every flag.

## Containers

The starters' `Dockerfile` builds once and runs any role; the command picks which. It compiles in one stage, keeps
only production dependencies, and runs as an unprivileged user:

```dockerfile
FROM node:24.14.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:24.14.1-alpine
WORKDIR /app
COPY --from=build --chown=65532:65532 /app/package.json ./
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
USER 65532:65532
ENV NODE_ENV=production
EXPOSE 8080 9090
ENTRYPOINT ["node", "node_modules/mayura/lib/cli/dist/bin.js"]
CMD ["serve", "--app", "dist/app.js"]
```

The entry point is the `mayura` CLI inside the installed package. The starters also pin the base image by digest,
and their `.dockerignore` keeps `.env`, local data and SQLite files out of the image.

Their `compose.yaml` is a production-shaped local stack: PostgreSQL, a one-shot migration, the server and a worker.

```yaml
services:
  postgres:
    image: postgres:17
    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}", POSTGRES_DB: app }
    volumes: [postgres-data:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U app -d app"], interval: 2s, timeout: 5s, retries: 30 }
  migrate:
    build: .
    command: ["migrate", "--app", "dist/app.js"]
    env_file: .env
    environment: { DATABASE_URL: "postgres://app:${POSTGRES_PASSWORD}@postgres:5432/app" }
    depends_on: { postgres: { condition: service_healthy } }
  server:
    build: .
    command: ["serve", "--app", "dist/app.js"]
    env_file: .env
    environment: { DATABASE_URL: "postgres://app:${POSTGRES_PASSWORD}@postgres:5432/app" }
    ports: ["8080:8080"]
    depends_on: { migrate: { condition: service_completed_successfully } }
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"], interval: 5s, timeout: 5s, retries: 30 }
  worker:
    build: .
    command: ["worker", "--app", "dist/app.js", "--probe-host", "0.0.0.0", "--probe-port", "9090"]
    env_file: .env
    environment: { DATABASE_URL: "postgres://app:${POSTGRES_PASSWORD}@postgres:5432/app" }
    depends_on: { migrate: { condition: service_completed_successfully } }
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9090/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"], interval: 5s, timeout: 5s, retries: 30 }
volumes:
  postgres-data:
```

```bash
cp .env.example .env
docker compose up --build
```

The server speaks plain HTTP on port 8080. Put your TLS proxy or load balancer in front of it, forwarding the
original `Host` header of the public origin. If the proxy rewrites `Host`, pass its addresses as `trustedProxies` and
have it set `X-Forwarded-Host` (see [Server and client](server-and-client.md#hosting-on-node)).

## Kubernetes

Build the image as in [Containers](#containers) and run it three ways. The arguments go to the image's entry point,
the `mayura` CLI. Keep configuration in a Secret (here `agents-env`) and terminate TLS at your ingress, which must pass
the original `Host` header through.

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: agents-migrate-v42 } # one Job per release, run to completion before the rollout
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/agents:v42
          args: ["migrate", "--app", "dist/app.js"]
          envFrom: [{ secretRef: { name: agents-env } }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: agents-server }
spec:
  replicas: 2
  selector: { matchLabels: { app: agents-server } }
  template:
    metadata: { labels: { app: agents-server } }
    spec:
      terminationGracePeriodSeconds: 45
      containers:
        - name: server
          image: registry.example.com/agents:v42
          args: ["serve", "--app", "dist/app.js"]
          envFrom: [{ secretRef: { name: agents-env } }]
          ports: [{ containerPort: 8080 }]
          readinessProbe: { httpGet: { path: /readyz, port: 8080 }, periodSeconds: 5 }
          livenessProbe: { httpGet: { path: /livez, port: 8080 }, periodSeconds: 10 }
---
apiVersion: v1
kind: Service
metadata: { name: agents-server }
spec:
  selector: { app: agents-server }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: agents-worker }
spec:
  replicas: 2
  selector: { matchLabels: { app: agents-worker } }
  template:
    metadata: { labels: { app: agents-worker } }
    spec:
      terminationGracePeriodSeconds: 45
      containers:
        - name: worker
          image: registry.example.com/agents:v42
          args: ["worker", "--app", "dist/app.js", "--probe-host", "0.0.0.0", "--probe-port", "9090"]
          envFrom: [{ secretRef: { name: agents-env } }]
          env: [{ name: MAYURA_WORKER_ID, valueFrom: { fieldRef: { fieldPath: metadata.name } } }]
          readinessProbe: { httpGet: { path: /readyz, port: 9090 }, periodSeconds: 5 }
          livenessProbe: { httpGet: { path: /livez, port: 9090 }, periodSeconds: 10 }
```

- `terminationGracePeriodSeconds` is longer than the server's `shutdownGraceMs` and the worker's `--drain-timeout-ms`
  (30 seconds each by default), so a rollout drains instead of cutting work off.
- Each worker replica needs its own `MAYURA_WORKER_ID` for its leadership lease; the pod name is a good one. One
  replica leads and the rest stand by.
- Run the migration Job to completion before updating the Deployments, for example from your CI with
  `kubectl wait --for=condition=complete job/agents-migrate-v42`, or as a Helm pre-upgrade hook.

## Managed container platforms

The same image runs on any platform that runs containers. On each, create a service for the server, an always-on
service for the worker, and a one-off job for the migration, all with the same environment.

- **AWS ECS on Fargate.** Two services from one task definition, overriding the command: `serve --app dist/app.js`
  behind an Application Load Balancer that checks `/readyz` on port 8080, and `worker --app dist/app.js` with no load
  balancer. Run the migration as a one-off task (`aws ecs run-task` with the `migrate` command) before updating the
  services, and set the container's `stopTimeout` above 30 seconds.
- **Google Cloud Run.** Deploy the server as a service on port 8080 with `/readyz` as its startup and readiness
  check, and the migration as a Cloud Run job. Cloud Run's defaults scale to zero and stop the CPU between requests,
  which pauses agent runs and workflows, so give both the server and the worker CPU that is always allocated and at
  least one minimum instance.
- **Azure Container Apps.** A container app for the server with ingress on port 8080 and health probes on `/livez`
  and `/readyz`, a second container app for the worker with no ingress and at least one replica, and a Container Apps
  job for the migration.
- **Fly.io.** One app with two process groups, the migration as the release command, and machines that are never
  stopped automatically:

  ```toml
  [processes]
    app = "serve --app dist/app.js"
    worker = "worker --app dist/app.js"

  [deploy]
    release_command = "migrate --app dist/app.js"

  [http_service]
    internal_port = 8080
    processes = ["app"]
    auto_stop_machines = "off"
    min_machines_running = 1
  ```

Wherever you run, put TLS in front of the server and keep its `publicOrigin` equal to the public URL (see
[Production server settings](#production-server-settings)).

## Platforms with process types

Platforms that run processes from your repository need three commands and nothing else. On Heroku, a `Procfile`:

```text
release: npx mayura migrate --app dist/app.js
web: npx mayura serve --app dist/app.js
worker: npx mayura worker --app dist/app.js
```

On Render and Railway, create a web service and a background worker from the same repository with the `web` and
`worker` commands above, and set the migration as the pre-deploy command. The server listens on the platform's
`PORT` (the example module reads it), the platform terminates TLS, and the build step compiles your TypeScript. Keep
at least one instance of each running.

## Virtual machines

On a server of your own, run the two long-lived roles as systemd services and the migration from your deploy script.
Put a TLS proxy such as Caddy or nginx in front of port 8080.

```ini
# /etc/systemd/system/agents-server.service
[Unit]
Description=Agents server
After=network-online.target
Wants=network-online.target

[Service]
User=agents
WorkingDirectory=/srv/agents
EnvironmentFile=/etc/agents/env
ExecStart=/usr/bin/node node_modules/mayura/lib/cli/dist/bin.js serve --app dist/app.js
Restart=on-failure
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
```

The worker's unit is the same with `worker --app dist/app.js` in `ExecStart`. systemd stops services with `SIGTERM`,
which starts the graceful stop, and `TimeoutStopSec` gives it time to drain. To deploy, install and build the new
release, run `mayura migrate --app dist/app.js`, then restart both services. Keep `/etc/agents/env` readable only by
the service user.

## Inside an existing Node.js app

If you already run a Node.js server, mount Mayura's API in it instead of running `mayura serve`.
`createAgentServer` from `mayura/server` returns a standard `fetch(request)` handler; send every request whose path
starts with `/v1/` to it and serve your own routes as usual. Set `mounted: true`, so the handler trusts only the path
and query your framework routed to it, never the `Host` header (see
[Server and client](server-and-client.md#mounting-the-handler-yourself)).

A Next.js route handler, for an app that runs on a Node.js server with `next start`:

```ts
// app/v1/[...path]/route.ts
import { createAgentServer } from 'mayura/server';

const api = createAgentServer({ publicOrigin: 'https://agents.example.com', mounted: true, agents, authenticate });

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => api.fetch(request);
export const POST = (request: Request) => api.fetch(request);
```

In Hono it is `app.all('/v1/*', context => api.fetch(context.req.raw))`, and any framework that gives you a web
`Request` works the same way. The API stays at `/v1/` on your public origin, where `mayura/client` expects it. The
repository's `examples/embedded-handler.mjs` runs this end to end.

Durable workflows still need `mayura worker`, and storage still needs `mayura migrate`: give your module `worker()`
and `migrate()` and run those two commands next to your app.

## Serverless functions

Vercel Functions, AWS Lambda and Google Cloud Run can run Mayura as functions: short-lived instances that handle
requests and may be frozen or stopped as soon as they respond.

- **Vercel Functions are tested on Vercel**: request-bound runs, workflows advanced by one-shot invocations, and a
  function stopped at its time limit in the middle of a step, then recovered, all on PostgreSQL through a pooled
  connection.
- **Experimental: AWS Lambda, Google Cloud Run, Vercel Cron and the Next.js route files below.** They follow the same
  rules and pass the same local tests, which run every invocation as a process stopped as soon as it answers, but have
  not yet run on those platforms. Their setup may change in any release.

Four settings make functions safe:

- **Runs finish inside their request.** Mount the API with `runExecution: 'request'` and `runRecords` (see
  [Request-bound runs](server-and-client.md#request-bound-runs)): each run finishes before its response, and any
  instance can read it afterwards. Keep each agent's `limits.maxDurationMs`, plus the server's `requestTimeoutMs`,
  under the function's time limit. Work that takes longer belongs in a durable workflow.
- **Workflows advance on a schedule.** A scheduled invocation calls `worker.runOnce({ budgetMs })` every minute; it
  advances everything that is due and returns (see [Run once](../cli/run.md#run-once)). Keep the budget under the
  function's time limit by at least your longest tool's `timeoutMs`. A step cut off by a timeout or a crash is settled
  as unknown by a later invocation, and never run twice.
- **Small connection pools.** Every instance opens its own pool, so use `pool: { max: 1 }` and your provider's pooled
  connection string (see [Storage](storage.md#postgresql)).
- **Migrations from your pipeline.** Run `mayura migrate` from CI before you release new functions.

One module holds all of it; each platform's entry points below only call into it:

```ts
// src/mayura.ts
import { createAgentServer } from 'mayura/server';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createPostgresStore } from 'mayura/storage-postgres';
import { createWorkflowLeadership, createWorkflowWorker } from 'mayura/workflows';
import { createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';

const store = createPostgresStore({ connectionString: process.env['DATABASE_URL']!, pool: { max: 1 } });
const ready = store.initialize();

const api = createAgentServer({
  publicOrigin: 'https://agents.example.com', mounted: true, agents, authenticate,
  runRecords: createAggregateRunRecords(store),
  runExecution: 'request',
});

/** Answer one request to Mayura's API. */
export async function handle(request: Request): Promise<Response> {
  await ready;
  return api.fetch(request);
}

/** Advance every workflow that is due, then return: for the scheduled invocation. */
export async function advanceWorkflows() {
  await ready;
  const host = createWorkflowLifecycleHost({ store, scope, definitions, permissions, policyVersion: '1', maxCostMicros });
  const leadership = createWorkflowLeadership({ store, scope, role: 'workflows', holderId: crypto.randomUUID() });
  return createWorkflowWorker({ units: [host], leadership }).runOnce({ budgetMs: 50_000 });
}
```

### Vercel

A route for the API and a cron route for workflows, in a Next.js app on the Node.js runtime. The tested setup used plain
Vercel Functions (`api/*.js` files exporting `GET` and `POST`) that call the same two functions; the Next.js route
files and Vercel Cron are experimental.

```ts
// app/v1/[...path]/route.ts
import { handle } from '@/src/mayura';

export const runtime = 'nodejs';
export const maxDuration = 300; // seconds: above maxDurationMs plus requestTimeoutMs
export const GET = handle;
export const POST = handle;
```

```ts
// app/api/advance-workflows/route.ts
import { advanceWorkflows } from '@/src/mayura';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  // Vercel sends your project's CRON_SECRET with every cron invocation; refuse anything else.
  if (request.headers.get('authorization') !== `Bearer ${process.env['CRON_SECRET']}`) return new Response('Unauthorized', { status: 401 });
  return Response.json(await advanceWorkflows());
}
```

```json
{ "crons": [{ "path": "/api/advance-workflows", "schedule": "* * * * *" }] }
```

The last block is `vercel.json`. Set `CRON_SECRET` in the project's environment variables. How often cron jobs may run
depends on your Vercel plan.

### AWS Lambda (experimental)

One function answers the API through a function URL; a second one, invoked every minute by EventBridge Scheduler,
advances workflows. Give the second a timeout above its budget, such as 60 seconds.

```ts
// api.ts: the handler of a Lambda function with a function URL
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handle } from './mayura.js';

export async function handler(event: APIGatewayProxyEventV2) {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const response = await handle(new Request(`https://${event.requestContext.domainName}${event.rawPath}${query}`,
    { method: event.requestContext.http.method, headers: event.headers as Record<string, string>, body }));
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}
```

```ts
// workflows.ts: the handler EventBridge Scheduler invokes every minute
import { advanceWorkflows } from './mayura.js';

export const handler = () => advanceWorkflows();
```

A buffered Lambda response delivers event streams only when they end; runs are request-bound, so `run.result()` is
ready as soon as the submission returns.

### Google Cloud Run (experimental)

Deploy the server as a service with request-based billing, where the CPU runs only during requests, and set
`runExecution: 'request'` as above; your module's `server()` can pass it to `listenProductionServer`. Advance workflows
with a Cloud Run job that runs `mayura worker --app dist/app.js --once --budget-ms 50000`, executed every minute by
Cloud Scheduler, and run `mayura migrate` as another job before each release. With instance-based billing, where the
CPU is always allocated, the [managed container](#managed-container-platforms) setup works as it is.

## Edge runtimes

Cloudflare Workers, Deno and Bun are not supported yet; support is planned for Mayura 1.1. The browser-safe
`mayura/client` already works anywhere `fetch` does, so an app on an edge runtime can call a Mayura server that runs on
one of the targets above.

## Environment and secrets

Mayura itself reads no environment variables. Your module decides what it reads, and nothing is discovered
implicitly: no config files, no default credentials. The starters use these names:

| Variable | Used for |
| --- | --- |
| `MAYURA_ENV` | `production` turns on the production server and the checks below. |
| `MAYURA_PUBLIC_ORIGIN` | The exact `https://` origin clients use. Required in production. |
| `PORT`, `MAYURA_BIND` | Where the server listens (default `8080` on `0.0.0.0`). |
| `MAYURA_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the API. |
| `DATABASE_URL` | PostgreSQL. Without it the starters fall back to a local SQLite file. |
| `MAYURA_OPERATOR_TOKEN_SHA256` | Comma-separated SHA-256 digests of operator tokens. Several digests let you rotate. |
| `MAYURA_SESSION_SECRET` | The key that signs user sessions (support-agent starter). Same value on every replica. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Model provider keys, plus price and cost-limit settings. |
| `MAYURA_WORKER_ID` | A stable name for the worker's leadership lease. Defaults to host name and process id. |

Validate configuration once at startup and fail fast. The starters do this with `validatedEnvironment` from
`mayura/helpers` and a Zod schema, and refuse to start in production without a public origin or operator token
digests. Keep secrets in your platform's secret store, never in the image, and never ship a server secret
or provider key to a browser. Each starter has `npm run token`, which prints a new token and the digest to configure.

## Probes

| Process | Endpoint | Answers 200 when |
| --- | --- | --- |
| Server | `GET /livez` | The process is up and not shutting down. |
| Server | `GET /readyz` | The server is accepting traffic and your `readiness` callback returned `true` within 2 seconds. |
| Worker | `GET /livez` on `--probe-port` | The worker is not stopping. |
| Worker | `GET /readyz` on `--probe-port` | The worker has started, is not draining, and has reached storage recently. |

Probes need no token, return only a status word, and skip the server's `Host` check, so orchestrators can call pods
directly. Worker probes are off unless you pass `--probe-port`; `--probe-host` defaults to `127.0.0.1`, so use
`0.0.0.0` inside a container.

## Graceful shutdown

On `SIGTERM` or `SIGINT`, the first signal starts a graceful stop and a second one forces the process to exit.

- **Server**: readiness fails at once so load balancers stop routing, the listener stops accepting, in-flight requests
  get up to `shutdownGraceMs` (30 seconds by default) to finish, then open streams and runs are closed and your
  `shutdown()` runs.
- **Worker**: readiness fails, work in progress gets up to `--drain-timeout-ms` (30 seconds by default, at most 300
  seconds) to settle, the leadership lease is released so a standby takes over immediately, then `shutdown()` runs.
  The CLI reports whether everything settled in time and how much work it had to interrupt.

Give containers a stop grace period longer than these timeouts (Docker's `stop_grace_period`, Kubernetes'
`terminationGracePeriodSeconds`). An effect that was in flight when a process died is never repeated. Once the tool's
timeout and a further minute have passed, the next worker pass records it as unknown for an operator to reconcile (see
[Workflow operations](workflow-operations.md)).

## PostgreSQL and scaling

Use PostgreSQL in production. The server, workers and migrations are separate processes that share workflow state,
idempotency records, the fleet hold and leadership leases through it. SQLite suits development and single-machine
setups. See [Storage](storage.md) for installation, backups and schema versions.

- **Workers** scale freely. Leadership lets one replica advance the fleet at a time, and a crashed leader's lease
  expires so another takes over. Operators can hold the whole fleet from the console or CLI during an incident.
- **Servers** scale to several replicas behind a load balancer, with no sticky sessions. With `runRecords` (as in the
  example), each agent run executes on the replica that accepted it, and any replica can read it, stream its events,
  wait for it and cancel it; a retried submission on any replica gets the same run. If a replica dies, its runs end as
  `outcome_unknown` once their lease lapses (30 seconds by default), never silently lost. Keep replica clocks in sync.
  Work that must continue after its replica dies belongs in durable workflows. See
  [Several server replicas](server-and-client.md#several-server-replicas).

## Production server settings

`listenProductionServer` has no hidden defaults for where it listens. The settings that matter most:

| Setting | Notes |
| --- | --- |
| `publicOrigin` | Exact `https://` origin. Requests with any other `Host` get 421. |
| `hostname`, `port` | Required bind address and port. |
| `tls` | `{ terminatedBy: 'proxy' }` behind a TLS proxy, or `{ key, cert }` to terminate TLS in the process (TLS 1.2 or later). |
| `readiness` | Checks your dependencies for `/readyz`, for example a storage read. |
| `shutdownGraceMs` | Default 30,000, at most 120,000. |
| `maxConnections` | Default 1,024. |
| `hstsMaxAgeSeconds` | Default one year; 0 turns the header off. |
| `limits` | Request, run, stream and size caps (see [Server and client](server-and-client.md)). |
| `allowedOrigins` | Browser origins other than `publicOrigin` allowed to call the API. |
| `trustedProxies` | IP addresses of proxies that rewrite `Host` and send `X-Forwarded-Host`. |
| `runRecords` | Durable agent run records, for several server replicas. |

Each registered agent also needs run `limits` that fit production, including `maxCostMicros` for paid models: the
default cost limit is 0. See [Costs and budgets](../concepts/costs-and-budgets.md).

## Good to know

- Mayura sends no telemetry. To export logs, traces or metrics, configure an exporter yourself (see
  [Observability](observability.md)).
- The server does not serve your web app's static files. Serve them from your proxy or a static host.
- Keep every workflow definition version that still has runs in flight registered in `definitions`, on both server
  and worker, until those runs finish or are migrated.

## Related

- [Server and client](server-and-client.md)
- [CLI: serve, worker and migrate](../cli/run.md)
- [Storage](storage.md)
- [Workflow operations](workflow-operations.md)
- [Observability](observability.md)
