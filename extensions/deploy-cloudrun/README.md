# @mayurajs/deploy-cloudrun

[Google Cloud Run](https://cloud.google.com/run) as a `mayura deploy` target. A migration job runs to completion,
then the server and an always-on worker deploy as services, all from one image, with gcloud.

```bash
npm install --save-dev @mayurajs/deploy-cloudrun
mayura deploy init --target cloudrun --apply
# In mayura.deploy.json: "image" is an Artifact Registry repository and targets.cloudrun.project is the project id.
mayura deploy --target cloudrun               # prints the plan and its digest
mayura deploy --target cloudrun --apply --confirm <digest>
```

A release runs these steps, stopping at the first failure:

1. `gcloud projects describe`, so a missing login or project stops it.
2. The image is built with Cloud Build, or with your Docker and pushed (`build: "local"`).
3. The `<name>-migrate` job is updated to the release's image, then run and waited for (`--execute-now --wait`, no
   retries). A failed migration stops the release.
4. `<name>-server` deploys with CPU always allocated and at least one instance, since agent runs continue after a
   response. It gets a `/readyz` startup probe and a one-hour request timeout for streams.
5. `<name>-worker` deploys as an internal, non-public service that serves only its probes, also always running.

Notes:

- **Secrets** come from Secret Manager with `--set-secrets`. By default, `DATABASE_URL` and every name in `env` read
  a secret of the same name at `latest`; map others with `secrets`, such as `{ "OPENAI_API_KEY": "openai-key:3" }`.
  Values never appear in a plan.
- **Settings** in `mayura.deploy.json` under `targets.cloudrun`:
  - `project`, and `region` (`us-central1`);
  - `build` (`cloud-build` or `local`) and `secrets`;
  - `cloudSqlInstance` (`project:region:instance`, for the Cloud SQL connector) and `serviceAccount`;
  - `public` (`true`: the server authenticates requests itself);
  - `serverMinInstances` and `workerInstances` (1 each).
- **Credentials:** gcloud uses its own login (`gcloud auth login`, or a service account in CI); Mayura reads neither.
  On Windows gcloud is a `.cmd` script, which `mayura deploy` runs through cmd.exe with checked, quoted arguments.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
