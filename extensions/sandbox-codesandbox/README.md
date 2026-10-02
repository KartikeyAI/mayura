# @mayurajs/sandbox-codesandbox

[CodeSandbox (Together) sandboxes](https://codesandbox.io/docs/sdk) for `mayura/sandbox`: Firecracker microVMs forked
from a template, through the CodeSandbox SDK (`@codesandbox/sdk`).

```bash
npm install mayura @mayurajs/sandbox-codesandbox @codesandbox/sdk
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { codeSandboxSandboxes } from '@mayurajs/sandbox-codesandbox';

const sandboxes = createSandboxes(codeSandboxSandboxes({ apiKey }), {
  maxSandboxes: 5, maxLifetimeMs: 3_600_000,
  network: ['all'], // CodeSandbox VMs always reach the internet
});
const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all' });
const result = await sandbox.exec(['node', '-e', 'console.log(6 * 7)']);
await sandbox.release();
```

- **CodeSandbox VMs reach the internet**, and this provider has no way to stop them, so it cannot enforce the network
  `'none'`: sandboxes are created only with `'all'`, listed in `createSandboxes` and asked for.
- Sandboxes are created **private** (CodeSandbox's own default is public), forked from `template` (its universal
  template by default; a sandbox's `image` names another), on `vmTier` (your workspace's default otherwise). `cpus` and
  `memoryMiB` are refused, and labels become tags (at most 10).
- CodeSandbox has no maximum lifetime: a release deletes the sandbox at its lifetime, and it hibernates when idle for
  that long (at most a day) should the release never come. A hibernated sandbox is kept, and can cost storage, until
  you delete it.
- CodeSandbox runs commands in a terminal, which joins and changes their output, so commands write their output to
  files, of which only as much as is kept is read back; standard input travels as a file. A timeout or cancellation
  kills the command's shell and every process carrying its tag. Files use the SDK's file system.
- `url(port)` gives a URL with a host token that lasts as long as the sandbox; anyone with it can open the port.
- **The SDK is a peer you install yourself** (`@codesandbox/sdk` 2.4.2 or a later 2.x): it brings its command line's
  dependencies with it, some of which declare no licence (such as `buffers`), so Mayura does not install it for you.
  It is loaded when first needed and typed here by its shape, since its own type files do not resolve under NodeNext.
  With `sdk` you pass a client you made instead. Node only. Options: `apiKey` (or `sdk`), `template`,
  `vmTier`, `workdir` (`/project/sandbox`), `maxLifetimeMs` (24 hours).

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
