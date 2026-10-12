---
title: "Fly.io deploy target"
description: "Deploy a Mayura app to Fly.io with @mayurajs/deploy-fly: fly.toml, server and worker process groups, the migration as release command."
package: "@mayurajs/deploy-fly"
vendor: "Fly.io"
logo: "fly"
website: "https://fly.io"
area: "deploy"
---

[Fly.io](https://fly.io) runs your app's image on Fly Machines. `@mayurajs/deploy-fly` adds `fly` as a target for
[`mayura deploy`](../cli/deploy.md): `deploy init` writes a `fly.toml` with the server and a workflow worker as two
process groups and the storage migration as Fly's release command, and each release runs `flyctl`, signed in as you.
The package has no dependencies besides `mayura`. It runs inside the `mayura` CLI on Node.js 22 or 24, on your
machine or in CI; nothing of it ships in your image.

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-fly
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need
[flyctl](https://fly.io/docs/flyctl/install/) on your `PATH`, and Docker for `build: "local"` or `build: "image"`.

## Credentials

Mayura reads no credentials. `flyctl` uses its own login: run `fly auth login` on your machine, or give it a token in
CI (the repository's `.env.example` uses `FLY_API_TOKEN`, which flyctl reads). Create tokens in the
[Fly.io dashboard](https://fly.io/dashboard). The login needs access to the app you deploy to. For `build: "image"`,
log Docker in to your registry yourself.

## Use it

Create the Fly app once and give it the app's secrets, then let `deploy init` write the files:

```bash
fly apps create refunds
fly secrets import --app refunds < .env.production
mayura deploy init --target fly            # shows the files it would write
mayura deploy init --target fly --apply    # writes them; review and commit
```

Settings live in `mayura.deploy.json` under `targets.fly`; all of them are optional:

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "app": "dist/src/app.js",
  "targets": {
    "fly": { "app": "acme-refunds", "region": "fra", "memory": "1gb" }
  }
}
```

Each release is planned first, then run with the plan's digest:

```bash
mayura deploy --target fly --tag v42                              # prints the plan and its digest
mayura deploy --target fly --tag v42 --apply --confirm <digest>
```

The tag defaults to the `version` in `package.json`. Your app module is the one the
[deployment guide](../guides/deployment.md#the-application-module) describes: `server()`, `worker()` and `migrate()`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `app` | the project `name` | The Fly app: lowercase letters, digits and hyphens, 3 to 63 characters. |
| `region` | `iad` | The primary region, a three-letter Fly region code such as `fra`. |
| `build` | `remote` | `remote` builds on Fly's builders, `local` with your Docker, `image` builds and pushes to your `image` registry, then deploys that image. |
| `vmSize` | `shared-cpu-1x` | Each machine's size. |
| `memory` | `512mb` | Each machine's memory, such as `512mb` or `2gb`. |
| `waitSeconds` | 600 | How long `flyctl deploy` waits for healthy machines (`--wait-timeout`), from 30 to 3600. |

Any other key under `targets.fly` is refused.

## Files it writes

| File | Contents |
| --- | --- |
| `Dockerfile`, `.dockerignore` | The image every role runs, with the `mayura` CLI as its entry point. |
| `fly.toml` | The app, region, process groups, release command, checks and machine size. |
| `mayura.deploy.json` | Only when the project has none. |

In `fly.toml`:

- `[processes]`: `app` runs `serve --app <app>`, `worker` runs `worker --app <app> --probe-host 0.0.0.0 --probe-port 9090`.
- `[deploy]`: `release_command = "migrate --app <app>"`, which Fly runs before each release and which stops the release
  when it fails, and `strategy = "rolling"`.
- `[http_service]` on the server's port for the `app` group, with `force_https`, a `/readyz` check,
  `auto_stop_machines = "off"` and `min_machines_running = 1`: agent runs continue after a response, so machines never
  stop on their own.
- `[checks.worker_ready]`: an HTTP check on the worker's probe port at `/readyz`.
- `kill_signal = "SIGTERM"` and `kill_timeout = "45s"`, longer than the server's and worker's 30-second drain.

The file is yours to edit. A release only checks that it still names the configured app.

## A release

| Step | Command | What it does |
| --- | --- | --- |
| `check-app` | `flyctl status --app <app>` | Stops the release before anything is built if the app is missing or flyctl is not logged in. |
| `build-image`, `push-image` | `docker build`, `docker push` | Only with `build: "image"`: the image at `<image>:<tag>`. |
| `deploy` | `flyctl deploy --app <app> --config fly.toml --strategy rolling --wait-timeout <n>s` | With `--remote-only` or `--local-only` and `--image-label <tag>`, or with `--image <image>:<tag>`. Fly runs the migration first. |

A run stops at the first failing step and skips the rest. With `build: "image"`, `image` in `mayura.deploy.json` is
required.

## Secrets and environment

Secrets stay in Fly: set them with `fly secrets set` or `fly secrets import`. They reach every process group,
including the release command. `env` in `mayura.deploy.json` is not used by this target, and no value ever appears in
a plan.

## What it never does

- Create the Fly app, set secrets, or scale machines: you do those with flyctl.
- Read credentials, or run a shell: each step is `flyctl` or `docker` with its arguments as planned.
- Overwrite `fly.toml` or the `Dockerfile` without the digest of the file plan that shows the change.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown (at `deploy init` and at every plan); `fly.toml` names another app than `targets.fly.app`; `build: "image"` without an `image`. |
| `NOT_FOUND` | `fly.toml` is missing: run `deploy init` first. `flyctl` or `docker` is not on your `PATH`. The package is not installed in the project. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan, for example because `fly.toml` or the tag changed since you reviewed it. |
| `TOOL_FAILED` | A tool could not be started. |

A step that exits non-zero fails the run: its status is `failed`, later steps are `skipped`, and the CLI exits with 1.
Ctrl+C stops the running tool and marks the rest `cancelled`.

## How it is tested

- Unit tests write the files into a temporary project and check `fly.toml` line by line: process groups, release
  command, checks, machines kept running, and the settings you gave.
- They plan releases for each build mode and compare every step's tool and arguments, refuse malformed settings, a
  missing `fly.toml` and one that names another app, and run a plan with a fake runner in place of flyctl to check
  that a failed `flyctl status` skips the deploy.
- A test installs the package into a project's `node_modules` and checks that `mayura deploy` resolves it as `fly`.
- The package has not yet deployed to a real Fly.io account.

## Related

- [Deploy with mayura deploy](../cli/deploy.md): plans, digests, `mayura.deploy.json` and how targets work.
- [Deployment](../guides/deployment.md#managed-container-platforms): the server, worker and migration on managed
  container platforms.
- [Fly Machines sandboxes](sandbox-fly.md): Fly.io as a sandbox provider.
