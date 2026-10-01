# @mayurajs/deploy-railway

[Railway](https://railway.com) as a `mayura deploy` target: a server service and a worker service from one
repository, each building from the Dockerfile and migrating storage before it goes live.

```bash
npm install --save-dev @mayurajs/deploy-railway
railway link                          # once: link the directory to the project
mayura deploy init --target railway --apply
mayura deploy --target railway        # prints the plan and its digest
mayura deploy --target railway --apply --confirm <digest>
```

- `deploy init` writes `deploy/railway/server.json` and `deploy/railway/worker.json`, Railway config-as-code files.
  Each uses the Dockerfile builder, a full start command (Railway's start command replaces the image's entry point)
  and the migration as its pre-deploy command, and the server also gets a `/readyz` health check.
- **Once per service:** set its config file in the service's settings: `/deploy/railway/server.json` for the server,
  and `/deploy/railway/worker.json` for the worker. Add PostgreSQL and the app's variables to both services.
- Both services migrate before going live. Migrations take a lock, so whichever runs first does the work.
- A release first runs `railway status`, so a missing login or link stops it. It then runs `railway up --ci` for the
  server and then the worker: each builds, migrates, and fails the release when either fails. `--ci` returns when
  the build is done, and Railway finishes the rollout.
- Settings in `mayura.deploy.json` under `targets.railway`: `serverService` and `workerService` (`<name>-server` and
  `<name>-worker` by default), and `environment` (the linked one by default).
- The Railway CLI uses its own login, or `RAILWAY_TOKEN` in CI; Mayura reads neither. On Windows, install the CLI's
  `.exe` (for example with Scoop): `mayura deploy` starts tools without a shell, so the npm `.cmd` shim is not
  supported there.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
