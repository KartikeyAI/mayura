# @mayurajs/sandbox-northflank

[Northflank](https://northflank.com/docs/v1/application/sandboxes) sandboxes for `mayura/sandbox`: a microVM service
per sandbox, through Northflank's JavaScript client (`@northflank/js-client`).

```bash
npm install mayura @mayurajs/sandbox-northflank
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { northflankSandboxes } from '@mayurajs/sandbox-northflank';

const sandboxes = createSandboxes(northflankSandboxes({ token, projectId: 'agents', image: 'ubuntu:24.04' }), {
  maxSandboxes: 5, maxLifetimeMs: 3_600_000,
  network: ['all'], // Northflank services always reach the internet
});
const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all' });
const result = await sandbox.exec(['uname', '-a']);
await sandbox.release();
```

- **Northflank services reach the internet**, and this provider has no way to stop them, so it cannot enforce the
  network `'none'`: sandboxes are created only with `'all'`, listed in `createSandboxes` and asked for.
- Each sandbox is a deployment service in `projectId` running `image` (a sandbox's own `image` overrides it) with a
  process that only sleeps; commands run in it through Northflank's exec. `deploymentPlan` sets CPU and memory
  (`nf-compute-20` by default); `cpus` and `memoryMiB` are refused. A sandbox is ready once a command runs in it.
- **Northflank services have no lifetime of their own.** A release deletes the service, and `createSandboxes` releases
  each sandbox when its lifetime ends; a service whose release never comes (the process holding it died) keeps running,
  and costing, until you delete it.
- Commands run in their directory with their environment set through `env`, take standard input, and only as much
  output as is kept is read. A timeout or cancellation stops every process the command started. Files are read and
  written through commands, so the image needs a POSIX shell and the usual tools.
- No ports yet. Node only. Options: `token` (or `client`), `projectId`, `teamId`, `image`, `deploymentPlan`, `workdir`
  (`/workspace`), `maxLifetimeMs` (24 hours).

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
