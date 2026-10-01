# @mayurajs/sandbox-e2b

[E2B](https://e2b.dev) sandboxes for `mayura/sandbox`: Firecracker microVMs started from an E2B template, over E2B's
HTTP APIs.

```bash
npm install mayura @mayurajs/sandbox-e2b
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { e2bSandboxes } from '@mayurajs/sandbox-e2b';

const sandboxes = createSandboxes(e2bSandboxes({ apiKey }), { maxSandboxes: 5, maxLifetimeMs: 3_600_000 });
const sandbox = await sandboxes.create({ lifetimeMs: 600_000 });
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
await sandbox.release();
```

- A sandbox's `image` is an E2B template id or alias; `template` sets the default (`base`). Its lifetime is E2B's
  timeout, after which E2B ends it; sandboxes are never paused.
- No internet unless allowed: `'none'` turns internet access off, `'all'` turns it on, and `{ allow: [domains] }`
  allows those domains and denies everything else. E2B matches domains on ports 80 (Host) and 443 (SNI) only, so
  other ports reach nothing.
- Ports listed at creation are served publicly at `https://<port>-<sandbox id>.e2b.app`; without ports, nothing is
  public.
- Commands run through `sh` in the sandbox. A timeout or cancellation sends SIGKILL to the command and to every
  process it started.
- Options: `apiKey`, `template`, `workdir` (`/home/user`), `maxLifetimeMs` (1 hour, Hobby; up to 24 hours on Pro),
  `apiUrl`, `domain`, `fetch`.
- No dependencies: requests go through fetch, and it runs on every runtime Mayura does. Nothing is read from the
  environment.

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
