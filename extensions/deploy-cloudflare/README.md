# @mayurajs/deploy-cloudflare

[Cloudflare](https://www.cloudflare.com) as a `mayura deploy` target, with `wrangler`, in two forms:
- **Containers** (the default) run your Mayura app module, as on any container platform;
- **Workers** run the serverless module at the edge.

```bash
npm install --save-dev @mayurajs/deploy-cloudflare wrangler
npm install @cloudflare/containers                 # Containers only
wrangler secret put DATABASE_URL                   # and each variable in env
mayura deploy init --target cloudflare --apply
mayura deploy --target cloudflare                  # prints the plan and its digest
DATABASE_URL=… mayura deploy --target cloudflare --apply --confirm <digest>
```

## Containers

**`deploy init` writes:**
- `wrangler.jsonc`, with two Durable-Object-backed container classes:
  - `MayuraServer`, the image's `serve`, spread across up to `maxInstances` instances;
  - `MayuraWorker`, `deploy/cloudflare/worker.Dockerfile`, the same build with the `worker` command.
- `deploy/cloudflare/worker.js`, the Worker in front:
  - sends `/v1/*` to a server container, and answers anything else with 404;
  - gives both containers `DATABASE_URL` and each name in `env` from the Worker's secrets;
  - on a cron trigger every minute, requests the worker container's `/readyz`, which starts it if it slept and keeps
    it awake.

**A release:**
1. Checks the `wrangler` login.
2. Builds the project and migrates storage from your machine, with the `DATABASE_URL` in your environment, since
   Containers have no pre-deploy step.
3. Runs `wrangler deploy`, which builds and pushes the images and updates the Worker and its containers.

## Workers

Set `targets.cloudflare.runtime` to `workers`. Your serverless module (`src/mayura.ts`, as in the deployment guide)
exports `handle(request, env)` and `advanceWorkflows(budgetMs, env)`; `env` carries bindings such as D1 or
Hyperdrive. Storage initializes itself on first use (`await ready`), under the schema lock.

**`deploy init` writes:**
- `wrangler.jsonc`, with `nodejs_compat` and a cron every minute;
- `deploy/cloudflare/worker.ts`: `fetch` calls `handle`, and the cron calls `advanceWorkflows` within 20 seconds.

**A release** checks the login and runs `wrangler deploy`, which bundles your TypeScript.

## Settings

In `mayura.deploy.json` under `targets.cloudflare`:
- `runtime`;
- `name` (the project name);
- `maxInstances` (3);
- `module` (`src/mayura.ts`, Workers);
- `cron` (`true`).

Secrets set with `wrangler secret put` are never deleted by a deploy. `wrangler` uses its own login, or
`CLOUDFLARE_API_TOKEN` in CI; Mayura reads neither. On Windows `wrangler` is a `.cmd` script, which `mayura deploy`
runs through cmd.exe with checked, quoted arguments.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
