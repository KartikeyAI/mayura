# @mayurajs/deploy-digitalocean

[DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform) as a `mayura deploy` target: the
server as a service, a worker, the migration as a pre-deploy job, and PostgreSQL, released with `doctl`.

```bash
npm install --save-dev @mayurajs/deploy-digitalocean
mayura deploy init --target digitalocean --apply   # writes .do/app.yaml and deploy/digitalocean/Dockerfile
doctl registry login                                # once
doctl apps create --spec .do/app.yaml               # once; then set targets.digitalocean.appId
mayura deploy --target digitalocean                 # prints the plan and its digest
mayura deploy --target digitalocean --apply --confirm <digest>
```

**The app spec** (`.do/app.yaml`) runs one image from DigitalOcean Container Registry, on the `release` tag:
- the `server` service, with a `/readyz` health check;
- a `worker`;
- a `migrate` job of kind `PRE_DEPLOY`;
- a PostgreSQL database (a development database, or `databaseCluster`), given to each as `DATABASE_URL`.

The image has no entry point, so the commands run in full as written.

**A release:**
1. Checks that `doctl` can reach the app.
2. Builds the image, then pushes it under the release's tag and under the app's tag (`release`).
3. Starts a deployment and waits until it is live.

The pre-deploy job migrates first, so a failed migration ends the deployment in `ERROR`, nothing new goes live, and
the release fails.

**Secrets.** Add the app's secret variables in the control panel. Releases never replace the app spec; they deploy
the image on its tag, so your variables are kept. To change the spec itself, edit `.do/app.yaml` and run
`doctl apps update <id> --spec .do/app.yaml` yourself, with the encrypted values `doctl apps spec get` gives you.

**Settings** in `mayura.deploy.json` under `targets.digitalocean`:
- `appId`;
- `channel` (`release`);
- `region` (`nyc`);
- `instanceSize` (`apps-s-1vcpu-1gb`) and `serverInstances` (1);
- `databaseCluster`;
- `timeoutSeconds` (1800).

`doctl` uses its own token (`doctl auth init`); Mayura reads none.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
