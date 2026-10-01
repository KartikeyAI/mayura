# @mayurajs/deploy-azure

[Azure Container Apps](https://azure.microsoft.com/products/container-apps) as a `mayura deploy` target, with `az`. A
release runs a migration job to success, then updates the server and the worker and waits for each new revision.

```bash
npm install --save-dev @mayurajs/deploy-azure
mayura deploy init --target azure --apply
# In mayura.deploy.json: "image": "<registry>.azurecr.io/refunds" and targets.azure.resourceGroup.
mayura deploy --target azure                  # prints the plan and its digest
mayura deploy --target azure --apply --confirm <digest>
```

**Once, before the first release**, create the environment, the two apps and the job from the image. Each runs the
image's `mayura` command with its own arguments and the same environment (secrets as `secretref:` variables, or Key
Vault references):

- `<name>-server`: ingress on port 8080, `/readyz` probes, at least one replica (agent runs continue after a
  response). Arguments: `serve --app dist/app.js`.
- `<name>-worker`: no ingress, one replica or more. Arguments:
  `worker --app dist/app.js --probe-host 0.0.0.0 --probe-port 9090`.
- `<name>-migrate`: a manual-trigger job with no retries. Arguments: `migrate --app dist/app.js`.

A release:

1. Checks that `az` is signed in.
2. Builds the image in Azure Container Registry with `az acr build`, or with your Docker and pushes it
   (`build: "local"`).
3. Points the migration job at the new image, starts it, and waits until it succeeds. A failed migration stops the
   release before any app changes.
4. Updates `<name>-server` and waits until its new revision is running.
5. Does the same for `<name>-worker`.

A revision that fails or degrades stops the release.

**Settings** in `mayura.deploy.json` under `targets.azure`:
- `resourceGroup` (letters, digits, `_`, `-` and `.`);
- `subscription`;
- `build` (`acr` or `local`);
- `registry` (by default from an `<registry>.azurecr.io` image);
- `migrationTimeoutSeconds` (1800) and `revisionTimeoutSeconds` (600).

`az` uses its own sign-in; Mayura reads no credentials. On Windows `az` is a `.cmd` script, which `mayura deploy` runs
through cmd.exe with checked, quoted arguments.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
