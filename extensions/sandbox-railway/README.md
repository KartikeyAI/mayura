# @mayurajs/sandbox-railway

[Railway Sandboxes](https://docs.railway.com/sandboxes) for `mayura/sandbox`: Linux VMs on demand, through Railway's
TypeScript SDK (`railway`).

```bash
npm install mayura @mayurajs/sandbox-railway
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { railwaySandboxes } from '@mayurajs/sandbox-railway';

const sandboxes = createSandboxes(railwaySandboxes({ token, environmentId }), {
  maxSandboxes: 5, maxLifetimeMs: 3_600_000,
  network: ['all'], // Railway sandboxes always reach the internet
});
const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all' });
const result = await sandbox.exec(['node', '-e', 'console.log(6 * 7)']);
await sandbox.release();
```

- **Railway sandboxes always have public internet egress**, so this provider cannot enforce the network `'none'`:
  sandboxes are created only with `'all'`, listed in `createSandboxes` and asked for. Anything else fails before a
  sandbox is made.
- `token` is a Railway API token (`authType: 'bearer'`, the default) or a project token (`'project-token'`), with the
  `environmentId` sandboxes go in. Nothing is read from the environment.
- Sandboxes are isolated from your environment's private network, except one created with `ports`: Railway publishes
  ports only for sandboxes that join it, so `url(port)` comes at that cost.
- Railway has no maximum lifetime, only an idle timeout: a release destroys the sandbox when its lifetime ends, and the
  idle timeout (the lifetime, at most 2 hours) ends one whose release never came.
- Commands run with Railway's exec; their output goes to files, of which only as much as is kept is read back, and
  standard input travels as a file. A timeout or cancellation kills the command's process group through Railway, and
  every process carrying its tag. Files use Railway's file API.
- Sandboxes start from Railway's default image; `image`, `cpus` and `memoryMiB` are refused (use a Railway template
  for a custom image). Options: `token`, `authType`, `environmentId`, `region`, `workdir` (`/workspace`),
  `maxLifetimeMs` (24 hours), `fetch`. Railway's SDK brings `graphql` and, for its infrastructure-as-code command
  line, `tsx`.

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
