---
title: "Serve, worker and migrate"
description: "Run your application in production with mayura serve, mayura worker and mayura migrate, and write the module they load."
---

In production a Mayura application usually runs as separate processes: one or more **servers** that answer HTTP
requests, one or more **workers** that advance durable workflows, and a **migration** step that updates the storage
schema before new code starts. The CLI runs each of these from one application module that you write:

```bash
mayura migrate --app dist/src/app.js
mayura serve --app dist/src/app.js
mayura worker --app dist/src/app.js --probe-host 0.0.0.0 --probe-port 9090
```

The CLI owns only the process lifecycle: starting, handling Ctrl+C or `SIGTERM`, graceful shutdown and worker probes.
Your module wires its own storage, agents, workflows and authentication with its own installed `mayura` package.

## The application module

The module's default export is an object with up to four functions. Wrap it in `defineMayuraApplication` from
`mayura/cli`, which checks the shape:

```ts
import { defineMayuraApplication } from 'mayura/cli';
import { listenProductionServer } from 'mayura/server-node';
import { createWorkflowWorker } from 'mayura/workflows';

// openServices, agents, authenticate and workerUnits stand for your own code: storage, agent
// registrations, token verification and the workflow runtimes the worker drives.
let services: Promise<Services> | undefined;
const ready = () => (services ??= openServices());

export default defineMayuraApplication({
  async server() {
    await ready();
    return listenProductionServer({
      publicOrigin: 'https://agents.example.com',
      hostname: '0.0.0.0',
      port: 8080,
      tls: { terminatedBy: 'proxy' },
      agents,
      authenticate,
    });
  },
  async worker() {
    return createWorkflowWorker({ units: workerUnits(await ready()) });
  },
  async migrate() {
    await ready();
    return { schemaVersion: 1 };
  },
  async shutdown() {
    if (services) await (await services).close();
  },
});
```

| Function | Used by | Must return |
|---|---|---|
| `server()` | `mayura serve` | A running server with `isAccepting()` and `close()`, such as the result of `listenProductionServer` from `mayura/server-node` |
| `worker()` | `mayura worker` | A worker with `start()`, `isReady()` and `drain()`, such as the result of `createWorkflowWorker` from `mayura/workflows` |
| `migrate()` | `mayura migrate` | Any JSON-serializable report, printed when the migration finishes |
| `shutdown()` | all three | Nothing. Runs last, after the server closes, the worker drains or the migration ends, for example to close storage. |

Define at least one function, and only these four. A command whose function is missing fails with `INVALID_CONFIG`,
for example `mayura worker` on a module without `worker`.

`--app` must name a single regular `.js` or `.mjs` file: build your TypeScript first. Directories, symbolic links and
other file types are refused, and the CLI imports nothing else. For a complete, working module, see `src/app.ts` in
any starter, such as
[approval-workflow](https://github.com/KartikeyAI/mayura/blob/main/packages/cli/starters/approval-workflow/src/app.ts).

## mayura serve

`mayura serve --app <module>` calls `server()` and keeps it running. On the first Ctrl+C or `SIGTERM` it closes the
server gracefully, then calls `shutdown()`. A second signal during shutdown forces the process to exit.

`listenProductionServer` stops accepting new requests, fails its readiness check so load balancers stop routing to
it, and drains in-flight requests before it closes. See [Deployment](../guides/deployment.md).

## mayura worker

`mayura worker --app <module>` calls `worker()`, then `start()`. On the first Ctrl+C or `SIGTERM` it drains the
worker, waiting for in-flight work to finish, then calls `shutdown()`.

| Option | Meaning |
|---|---|
| `--drain-timeout-ms <ms>` | How long draining may take, from 1 to 300000. Default 30000. |
| `--probe-port <port>` | Serve HTTP health probes on this port. Off by default. |
| `--probe-host <host>` | The address the probes listen on. Default `127.0.0.1`. |

With `--probe-port`, the worker answers two probes for your orchestrator:

- `GET /livez` returns 200 while the process is running, and 503 once it starts stopping.
- `GET /readyz` returns 200 while the worker reports itself ready, and 503 when it does not, for example while it is
  draining. A worker with a leadership lease is ready only while it can confirm the lease in storage.

The probe listener comes from `mayura/server-node` in your application's own installation, so `mayura` must be
installed alongside the module. In a container, use `--probe-host 0.0.0.0` so the orchestrator can reach it.

When the worker stops, it reports whether the drain finished in time, and how much work was interrupted if it did not.

### Run once

With `--once`, the worker advances everything that is due and exits, instead of running until it is stopped. Use it
from a scheduled job (a Cloud Run job, a Kubernetes CronJob) or a scheduler that starts a process every minute:

```bash
mayura worker --app dist/src/app.js --once --budget-ms 50000
```

It takes the leadership lease once, runs passes until every host has completed a sweep of its runs or the budget runs
out, then releases the lease and calls `shutdown()`. A pass that has started finishes, so keep the budget below your
platform's time limit by at least your longest tool's `timeoutMs`. Each host keeps its place in storage, so if a sweep
does not finish, the next run continues from there rather than starting over.

| Option | Meaning |
|---|---|
| `--once` | Advance what is due, then exit. Not with `--probe-port`, `--probe-host` or `--drain-timeout-ms`. |
| `--budget-ms <ms>` | Stop starting passes after this long, from 1000 to 3600000. Default 60000. |

It prints a report and its status:

| Status | Meaning | Exit code |
|---|---|---|
| `succeeded` | Every host completed a sweep. | 0 |
| `incomplete` | The budget ran out first; the next run continues. Run it more often or give it more time. | 0 |
| `standby` | Another replica holds the lease, so this run did nothing. | 0 |
| `held` | An operator holds the fleet, so nothing was driven. | 0 |
| `failed` | A pass failed, for example because storage was unavailable. | 1 |

The worker must come from `createWorkflowWorker`, whose `runOnce` this calls; in your own code, such as a scheduled
function, call `worker.runOnce({ budgetMs })` directly.

## mayura migrate

`mayura migrate --app <module>` calls `migrate()` once, then `shutdown()`, and exits. Nothing else starts. Run it
before deploying new code, for example as a release step or an init container:

```bash
mayura migrate --app dist/src/app.js --json
```

Migrations are explicit and one-way. Mayura's storage refuses data in a format or schema version it does not
support; see [Storage](../guides/storage.md).

## Output

In a terminal each command prints one line per stage:

```text
● Worker started, probes on 0.0.0.0:9090. Press Ctrl+C to stop.
● Stopping… (press Ctrl+C again to force)
✔ Stopped
```

When output is piped, as in most deployments, each stage is one JSON line, then the command's final JSON document:

```text
{"event":"worker-started","probe":{"hostname":"0.0.0.0","port":9090}}
{"event":"stopping"}
{"event":"stopped","drained":true,"interrupted":0}
```

`serve` prints `serving`, `stopping` and `stopped` events. `migrate` prints `{ "status": "migrated", "report": <report> }`,
where the report is whatever your `migrate()` returned. See [CLI overview](overview.md) for exit codes and errors.

## Good to know

- `serve` and `worker` do not load `.env`. Set configuration in the real process environment. Only
  [mayura dev](dev.md) reads `.env`.
- Run servers and workers as separate processes. With a leadership lease (`createWorkflowLeadership` from
  `mayura/workflows`), several worker replicas can run without driving the same workflows twice.

## Related

- [Deployment](../guides/deployment.md)
- [Develop with mayura dev](dev.md)
- [Server and client](../guides/server-and-client.md)
- [Workflow operations](../guides/workflow-operations.md)
- [Storage](../guides/storage.md)
