# @mayurajs/sandbox-cloudflare

[Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/) for `mayura/sandbox`: containers driven by Durable
Objects, reached through the **sandbox bridge**, Cloudflare's reference Worker that exposes the Sandbox SDK over HTTP.
You deploy the bridge in your Cloudflare account; this package talks to it over `fetch`, with no dependencies, from
any runtime (Node, Bun, Deno, Workers, Vercel Edge).

```bash
npm install mayura @mayurajs/sandbox-cloudflare
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { cloudflareSandboxes } from '@mayurajs/sandbox-cloudflare';

const sandboxes = createSandboxes(cloudflareSandboxes({ bridgeUrl: 'https://sandbox-bridge.example.workers.dev', apiKey }), {
  maxSandboxes: 5, maxLifetimeMs: 3_600_000,
  network: ['all'], // Cloudflare sandboxes reach the internet
});
const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all' });
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
await sandbox.release();
```

- `apiKey` is the bridge's `SANDBOX_API_KEY`, sent as a bearer token; nothing is read from the environment.
  `bridgeUrl` must be `https` (or `localhost` while you develop the bridge).
- **Sandboxes reach the internet**, and the bridge does not say whether its Worker blocks that, so this provider cannot
  enforce the network `'none'`: sandboxes are created only with `'all'`, listed in `createSandboxes` and asked for.
- The image and instance type are set where the bridge is deployed: `image`, `cpus` and `memoryMiB` are refused. No
  ports are served here.
- The bridge has no lifetime to set: a release deletes the sandbox at its lifetime. Should the release never come, the
  sandbox stays until Cloudflare puts its idle container to sleep.
- The bridge's exec takes no environment and no standard input, so a command's environment (with the sandbox's) and its
  input travel as files uploaded first and removed after; neither is on a command line. Output streams back as events,
  of which only as much as is kept is read. A timeout or cancellation kills every process carrying the command's tag.
- The bridge writes files only under `/workspace`: writes elsewhere are uploaded there and moved into place. Reads and
  listings run as commands, so they reach any path.
- Only the bridge is supported: using the Sandbox SDK's binding from inside your own Worker is not, yet.
- Options: `bridgeUrl`, `apiKey`, `maxLifetimeMs` (24 hours), `fetch`.

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
