# @mayurajs/sandbox-daytona

[Daytona](https://www.daytona.io) sandboxes for `mayura/sandbox`, over Daytona's REST and toolbox APIs.

```bash
npm install mayura @mayurajs/sandbox-daytona
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { daytonaSandboxes } from '@mayurajs/sandbox-daytona';

const sandboxes = createSandboxes(daytonaSandboxes({ apiKey }), { maxSandboxes: 5, maxLifetimeMs: 3_600_000 });
const sandbox = await sandboxes.create({ lifetimeMs: 600_000 });
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
await sandbox.release();
```

- A sandbox's `image` is a Daytona snapshot; `snapshot` sets the default (Daytona's own otherwise). `cpus` are whole
  CPUs and `memoryMiB` whole GiB.
- Its lifetime is Daytona's time to live, after which Daytona destroys it. It is never stopped for being idle, and
  is deleted if it stops.
- No network unless allowed: `'none'` blocks all network access, `'all'` allows it, and `{ allow: [domains] }` sets
  Daytona's domain allowlist. Sandboxes are never public; `url(port)` gives a signed preview URL, valid while the
  sandbox lives, that carries its own access, so treat it as a secret.
- Each command runs in its own toolbox session. Its output goes to files in the sandbox, and only as much as is kept
  (`maxOutputBytes`) is read back. Standard input and the command's environment are uploaded as files, so neither
  appears in the command Daytona records. A timeout or cancellation stops every process the command started.
- `desktop: true` gives sandboxes a desktop through Daytona's computer use (screenshots, mouse, keyboard, scrolling up
  and down), on snapshots that have it, and `desktop.viewUrl()` a signed noVNC view on port 6080.
- Options: `apiKey`, `organizationId`, `snapshot`, `target`, `workdir` (`/home/daytona`), `desktop`, `maxLifetimeMs`
  (24 hours), `apiUrl`, `fetch`. No dependencies: requests go through fetch. Nothing is read from the environment.

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
