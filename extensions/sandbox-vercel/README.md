# @mayurajs/sandbox-vercel

[Vercel Sandbox](https://vercel.com/docs/sandbox) for `mayura/sandbox`: Firecracker microVMs on Vercel, over Vercel's
REST API.

```bash
npm install mayura @mayurajs/sandbox-vercel
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { vercelSandboxes } from '@mayurajs/sandbox-vercel';

const sandboxes = createSandboxes(vercelSandboxes({ token, teamId, projectId }), { maxSandboxes: 5, maxLifetimeMs: 2_700_000 });
const sandbox = await sandboxes.create({ lifetimeMs: 600_000 });
const result = await sandbox.exec(['node', '-e', 'console.log(6 * 7)']);
await sandbox.release();
```

- `token` is a Vercel access token (with `teamId` and `projectId`), or a deployment's OIDC token. Nothing is read
  from the environment.
- A sandbox's `image` is one of Vercel's runtimes (`node22`, `node24`, `node26`, `python3.13`) or a container image;
  `runtime` sets the default (`node24`). `cpus` is 1 or an even number, with 2,048 MiB of memory each.
- Sandboxes never persist: they are created with `persistent: false`, and a release stops the session and deletes the
  sandbox with its snapshots.
- No network unless allowed: `'none'` is Vercel's `deny-all`, `'all'` its `allow-all`, and `{ allow: [domains] }` a
  custom policy allowing those domains. Ports (1024 to 65535, at most 15) are served at Vercel's public URLs.
- Vercel's API takes no standard input (`features.stdin` is false). Listing and removing files run small shell
  scripts in the sandbox; writing sends a gzipped tarball. A timeout or cancellation kills the command through the API
  and stops every process it started.
- Options: `token`, `teamId`, `projectId`, `runtime`, `region`, `maxLifetimeMs` (45 minutes, Hobby; up to 24 hours on
  Pro), `apiUrl`, `fetch`. No dependencies: requests go through fetch.

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
