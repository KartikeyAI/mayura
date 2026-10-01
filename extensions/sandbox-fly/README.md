# @mayurajs/sandbox-fly

[Fly.io Machines](https://fly.io/docs/machines/) as sandboxes for `mayura/sandbox`: a Firecracker VM per sandbox in
one of your Fly apps, over the Machines API.

```bash
npm install mayura @mayurajs/sandbox-fly
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { flySandboxes } from '@mayurajs/sandbox-fly';

const sandboxes = createSandboxes(flySandboxes({ token, app: 'my-sandboxes', image: 'docker.io/library/node:24-slim' }), {
  maxSandboxes: 5, maxLifetimeMs: 3_600_000,
  network: ['all'], // Fly Machines always reach the internet
});
const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all' });
const result = await sandbox.exec(['node', '-e', 'console.log(6 * 7)']);
await sandbox.release();
```

- **Fly Machines reach the internet, and Fly cannot stop them.** So this provider cannot enforce the network
  `'none'`: sandboxes are created only with `'all'`, listed in the `network` option of `createSandboxes` and asked
  for in `create`. Anything else fails before a Machine is made. Choose another provider where a sandbox must be
  offline.
- Create the app first (`fly apps create my-sandboxes`) and give a token for it (`fly tokens create deploy`). Machines
  run `image`, which needs a POSIX shell, `sleep`, `base64` and `setsid`, as Alpine, Debian and most language images
  have.
- A Machine's only process sleeps out the sandbox's lifetime; then the Machine destroys itself. A release destroys it
  sooner. `cpus` are whole and `memoryMiB` a multiple of 256; `cpuKind` is `shared` or `performance`.
- Fly's exec runs at most 60 seconds and answers with text, so commands run in the background with their output in
  files, and output and files move as base64 in chunks of 1 MiB. Only as much output as is kept is read back. A timeout
  or cancellation stops every process the command started.
- No ports: Machines in an app share its address. Options: `token`, `app`, `image`, `region`, `cpuKind`, `workdir`
  (`/workspace`), `maxLifetimeMs` (24 hours), `apiUrl`, `fetch`. No dependencies: requests go through fetch.

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
