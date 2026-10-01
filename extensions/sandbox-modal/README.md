# @mayurajs/sandbox-modal

[Modal Sandboxes](https://modal.com/docs/guide/sandboxes) for `mayura/sandbox`, through Modal's JavaScript SDK
(`modal`).

```bash
npm install mayura @mayurajs/sandbox-modal
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { modalSandboxes } from '@mayurajs/sandbox-modal';

const sandboxes = createSandboxes(modalSandboxes({ tokenId, tokenSecret, image: 'python:3.13-slim' }), { maxSandboxes: 5, maxLifetimeMs: 3_600_000 });
const sandbox = await sandboxes.create({ lifetimeMs: 600_000 });
const result = await sandbox.exec(['python', '-c', 'print(6 * 7)']);
await sandbox.release();
```

- Give `tokenId` and `tokenSecret` (from `modal token new`), or a `client` you own. Sandboxes belong to the App
  `app` (`mayura-sandboxes` by default), created if missing, and run `image` from a registry; a sandbox's own `image`
  overrides it. `runtime` is `gvisor` or `vm` (which can run Docker); `regions` pins where they run.
- A sandbox's lifetime is Modal's timeout, after which Modal ends it; a release terminates it sooner.
- No network unless allowed: `'none'` blocks all network access, `'all'` allows it, and `{ allow: [domains] }` is
  Modal's outbound domain allowlist (matched on TLS SNI). Ports are served through Modal's encrypted tunnels.
- Commands run with Modal's exec, in binary: standard input is passed as given, and only as much output as is kept
  is read. A timeout or cancellation stops every process the command started. Files are read and written through
  commands in the sandbox, so the image needs a POSIX shell and the usual tools.
- Runs on Node, Deno and Bun (Modal's SDK uses gRPC), not at the edge. Modal's SDK brings its own dependencies
  (gRPC and protobuf). Options: `tokenId`, `tokenSecret`, `environment`, `client`, `app`, `image`, `workdir`
  (`/workspace`), `runtime`, `regions`, `maxLifetimeMs` (24 hours).

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
