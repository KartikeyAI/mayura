# @mayurajs/deploy-render

[Render](https://render.com) as a `mayura deploy` target: a Blueprint with the server as a web service, a background
worker and PostgreSQL, released with the Render CLI.

```bash
npm install --save-dev @mayurajs/deploy-render
mayura deploy init --target render --apply   # writes render.yaml and deploy/render/Dockerfile; commit and push them
# Once: in the dashboard, New > Blueprint from the repository, and enter the secrets it asks for. Then set
# targets.render.serverServiceId and workerServiceId (srv-…) in mayura.deploy.json.
mayura deploy --target render                # prints the plan and its digest
mayura deploy --target render --apply --confirm <digest>
```

- `render.yaml` describes:
  - a web service (`serve`, with a `/readyz` health check);
  - a background worker;
  - a PostgreSQL database, given to both as `DATABASE_URL`.
- Both services build from `deploy/render/Dockerfile`, an image without an entry point, so their full start and
  pre-deploy commands run as written.
- Both services migrate storage before they go live. Migrations take a lock, so whichever runs first does the work,
  and a failed migration fails the deploy.
- Each variable named in `env` in `mayura.deploy.json` is declared with `sync: false`. Render asks for its value when
  you create the Blueprint, so values never reach the repository.
- Render deploys from your repository, so push before releasing.
- A release:
  1. validates the Blueprint with `render blueprints validate`;
  2. runs `render deploys create <id> --wait` for the server, then the worker, stopping at the first failure.
- `autoDeploy` is `off` by default, so releases go through `mayura deploy`. Set `commit` or `checksPass` to let
  Render deploy on its own.
- Settings in `mayura.deploy.json` under `targets.render`:
  - `region` (`oregon`), `plan` (`starter`; pre-deploy commands need a paid instance type) and `databasePlan`
    (`basic-256mb`);
  - `autoDeploy`;
  - `serverServiceId` and `workerServiceId`.
- The Render CLI uses its own login (`render login`), or `RENDER_API_KEY` in CI. Mayura reads neither.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
