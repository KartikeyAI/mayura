# @mayurajs/sandbox-apple-container

Sandboxes on [Apple's `container`](https://github.com/apple/container) for `mayura/sandbox`: each sandbox is a Linux
container in its own lightweight VM on this Mac, driven through the `container` command line. It needs macOS 26 on
Apple silicon, with `container` installed and its system service started (`container system start`).

```bash
npm install mayura @mayurajs/sandbox-apple-container
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { appleContainerSandboxes } from '@mayurajs/sandbox-apple-container';

const sandboxes = createSandboxes(appleContainerSandboxes({ image: 'docker.io/library/python:3.13-slim', hostOnlyNetwork: 'mayura-offline' }), {
  maxSandboxes: 4, maxLifetimeMs: 3_600_000,
});
const sandbox = await sandboxes.create({ lifetimeMs: 600_000 }); // network 'none': on the host-only network
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
await sandbox.release();
```

- **Images are never pulled.** The image must be on this Mac already (`container image pull <image>`); one that is not
  is reported as a configuration mistake.
- **Apple's `container` has no network that reaches nothing.** With `hostOnlyNetwork`, sandboxes created with the
  network `'none'` go on that host-only network (`container network create --internal`, made if it is missing): it
  reaches no further than this Mac, but **it does reach this Mac**, so services listening on it are reachable from the
  sandbox. Without `hostOnlyNetwork`, sandboxes are created only with `'all'`, listed in `createSandboxes` and asked
  for.
- Every sandbox gets `cpus` and `memoryMiB` (2 and 1,024 MiB by default), and may ask for no more. No ports are served
  here.
- A sandbox runs `sleep` for its lifetime, under an init that reaps processes, and is removed when it ends (`--rm`); a
  release deletes it sooner.
- The sandbox's environment and each command's are written to files in the sandbox and read from there, never on a
  command line. A timeout or cancellation kills every process carrying the command's tag.
- The command line runs without a shell. `cli` is the command as program and arguments (`['container']` by default),
  for a `container` that is not on the `PATH`.
- Node only. Options: `image`, `cli`, `hostOnlyNetwork`, `user`, `workdir` (`/workspace`), `cpus`, `memoryMiB`,
  `maxLifetimeMs` (24 hours).

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
