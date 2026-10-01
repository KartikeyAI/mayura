# @mayurajs/deploy-vercel

[Vercel Functions](https://vercel.com/docs/functions) as a `mayura deploy` target: the API as one function behind a
`/v1` rewrite, workflows advanced every minute by Vercel Cron, and storage migrated before each release. This is the
setup Mayura's serverless support was tested with on Vercel (Vercel Cron itself is not yet tested there); see
[Serverless functions](https://mayurajs.com/docs/guides/deployment/#serverless-functions).

```bash
npm install --save-dev @mayurajs/deploy-vercel
vercel link                                   # once
mayura deploy init --target vercel --apply
mayura deploy --target vercel                 # prints the plan and its digest
DATABASE_URL=… mayura deploy --target vercel --apply --confirm <digest>
```

**Your module.** Write the serverless module the deployment guide describes (`src/mayura.ts`, with request-bound
runs and `pool: { max: 1 }`). It must export:
- `handle(request)`;
- `advanceWorkflows(budgetMs)`;
- `migrate()`, for example `export async function migrate() { await ready; return { schemaVersion: 1 }; }`.

**`deploy init` writes:**
- `vercel.json`:
  - the rewrite of `/v1/*` to the API function;
  - each function's `maxDuration` (300 and 60 seconds): keep the API's above your agents' `maxDurationMs`;
  - a cron every minute.
- `api/mayura.js`: the API, which puts the rewritten path back before calling `handle`.
- `api/advance-workflows.js`: advances workflows within the function's time. It answers only calls that carry the
  project's `CRON_SECRET`, which Vercel sends with each cron invocation, so set `CRON_SECRET` in the project's
  environment.
- `deploy/vercel/migrate.mjs`: runs `migrate()`.

**A release:**
1. Checks the Vercel CLI's login.
2. Builds the project here and migrates storage. Vercel has no pre-deploy step, so this uses the `DATABASE_URL` in
   your environment; Mayura never reads it.
3. Runs `vercel deploy --prod`, whose output must be the deployment's URL.

A failed migration stops the release before anything is deployed.

**Settings** in `mayura.deploy.json` under `targets.vercel`:
- `module`, the compiled serverless module (`dist/src/mayura.js` by default);
- `scope`, your team;
- `production` (`true`; `false` deploys a preview);
- `apiMaxDuration` and `advanceMaxDuration`;
- `cron` (`true`; how often cron may run depends on your plan).

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
