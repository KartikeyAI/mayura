# @mayurajs/deploy-fly

[Fly.io](https://fly.io) as a `mayura deploy` target: the server and a workflow worker as two process groups, and the
storage migration as the release command.

```bash
npm install --save-dev @mayurajs/deploy-fly
fly apps create refunds            # once
fly secrets import --app refunds < .env.production
mayura deploy init --target fly --apply
mayura deploy --target fly         # prints the plan and its digest
mayura deploy --target fly --apply --confirm <digest>
```

- `deploy init` writes `fly.toml`:
  - an `app` process (`serve`) and a `worker` process;
  - `release_command` runs the migration, which Fly runs before each release, stopping the release if it fails;
  - an `http_service` on the server's port with a `/readyz` check, and a `/readyz` check for the worker;
  - machines that never stop on their own, since agent runs continue after a response and workflows need a running
    worker.
- A release first runs `flyctl status`, so a missing app or login stops it before anything is built. It then runs
  `flyctl deploy` with a rolling strategy.
- Settings in `mayura.deploy.json` under `targets.fly`:
  - `app`: the project name by default;
  - `region`: `iad`;
  - `build`: `remote` (Fly's builders, the default), `local` (your Docker) or `image` (pushed to your `image`
    registry, then deployed);
  - `vmSize`: `shared-cpu-1x`; `memory`: `512mb`;
  - `waitSeconds`: 600.
- flyctl uses its own login (`fly auth login`). Mayura reads no credentials, and secrets stay in Fly.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
