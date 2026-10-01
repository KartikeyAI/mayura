---
title: "Deploy with mayura deploy"
description: "Write a target's deployment files, plan a release and run it with the tools you already use: Docker, Docker Compose, Kubernetes, or a platform package."
---

`mayura deploy` deploys a [Mayura application](../guides/deployment.md) in two steps, each one shown before anything
happens:

1. `mayura deploy init --target <id>` writes the files the target needs (a `Dockerfile`, a `compose.yaml`, Kubernetes
   manifests) for you to review and commit. It never overwrites a file without your confirmation.
2. `mayura deploy --target <id>` plans one release: every command, in order, with everything it is given. Run it
   with `--apply` and the plan's digest. Each command is one of the tools you already use and are logged in to:
   `docker`, `kubectl` or a platform's own CLI. Mayura reads no credentials and runs no shell.

```bash
mayura deploy init --target kubernetes            # plan the files
mayura deploy init --target kubernetes --apply    # write them; review and commit
mayura deploy --target kubernetes --tag v42       # plan the release and print its digest
mayura deploy --target kubernetes --tag v42 --apply --confirm <digest>
```

## Targets

| Target | Writes | A release |
|---|---|---|
| `docker` | `Dockerfile`, `.dockerignore` | builds the image and pushes it |
| `compose` | `Dockerfile`, `.dockerignore`, `compose.yaml` (PostgreSQL, migration, server, worker) | builds, runs the migration once, then starts or updates the server and worker and waits until they are healthy |
| `kubernetes` | `Dockerfile`, `.dockerignore`, `deploy/kubernetes/` (migration Job, server Deployment and Service, worker Deployment) | builds and pushes the image, runs the migration Job and waits for its outcome, then rolls out the server and worker and waits for both |

Platforms come as packages named `@mayurajs/deploy-<id>`: install one in the project and use its id as the target.
`mayura deploy targets` lists the built-in targets and the installed packages. Packages are loaded only from the
project's own dependencies.

## mayura.deploy.json

`deploy init` writes `mayura.deploy.json` when the project has none. Everything in it has a default except the image:

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "app": "dist/src/app.js",
  "image": "registry.example.com/acme/refunds",
  "port": 8080,
  "probePort": 9090,
  "env": ["OPENAI_API_KEY", "MAYURA_OPERATOR_TOKEN_SHA256"],
  "targets": {
    "kubernetes": { "namespace": "agents", "context": "prod-eu", "serverReplicas": 2, "workerReplicas": 2 }
  }
}
```

- `name` names services, Jobs and Secrets: lowercase letters, digits and hyphens. It defaults to the package name.
- `app` is the compiled [application module](../guides/deployment.md#the-application-module). It defaults to
  `dist/app.js` when `src` is the TypeScript root directory, and `dist/src/app.js` otherwise.
- `image` is the image repository, without a tag. A release's tag is `--tag`, or the `package.json` version.
- `env` lists the names of the variables the application reads. Their values never appear in a plan.
- `targets.<id>` holds each target's settings. For `kubernetes`: `namespace` (`default`), `context` (a kubeconfig
  context; set it, so a release never goes to whichever cluster happens to be current), `secret` (`<name>-env`),
  `serverReplicas` and `workerReplicas` (2), and `timeoutSeconds` (600). For `compose`: `projectName`.

## Plans and confirmation

A plan lists each step with its tool and arguments. Steps that apply rendered manifests show them in `--json`. The
plan's digest covers all of it: the target, the release, every argument and every manifest. `--apply` runs the
plan only when `--confirm` gives that digest, so what runs is exactly what you reviewed. If anything changed in
between, such as an edited manifest or a different tag, the digest differs and nothing runs.

During a run, each tool's output goes to standard error, and the result (each step's status and exit code) goes to
standard output. A run stops at the first failing step and skips the rest, so a failed migration never rolls out.
Ctrl+C stops the running tool and skips the remaining steps.

## Credentials and secrets

Mayura reads no credentials. Each tool uses its own login and configuration: `docker login`, your kubeconfig, or a
platform CLI's own login. The application's secrets stay where the platform keeps them:

- **Compose:** the project's `.env`, which `deploy init` never writes.
- **Kubernetes:** a Secret, by default `<name>-env`, that the manifests load with `envFrom`. Create it before the
  first release, for example with `kubectl create secret generic refunds-env --from-env-file=.env.production`.

## Kubernetes manifests

The manifests under `deploy/kubernetes/` are yours to edit: resources, probes, node selectors, annotations. They
contain two placeholders that a release fills in, and that must stay:

- `mayura-app-image`, the image, which becomes `<image>:<tag>`;
- `mayura-release` in the Job's name, which becomes the tag (lowercase, at most 13 characters), so each release runs
  its own migration Job.

The rendered manifests are given to `kubectl apply -f -`; the files on disk stay unchanged. The migration Job has
`backoffLimit: 0`, and the release waits for its outcome before anything rolls out.

## Write a target

A platform package exports a target as its default export:

```ts
import { defineDeployTarget, imageSteps } from 'mayura/cli/deploy';

export default defineDeployTarget({
  id: 'acme',
  description: 'Deploy to Acme Cloud.',
  tools: ['docker', 'acme'],
  settings: () => ({}),
  files: ({ project }) => ({ 'acme.toml': `app = "${project.name}"\n` }),
  plan: ({ release }) => [
    ...imageSteps(release, 'acme'),
    { id: 'deploy', description: 'Deploy the release', tool: 'acme', args: ['deploy', '--image', release.image ?? ''] },
  ],
});
```

A target may run only the tools it declares, by name; a step naming any other program is refused when the release
is planned. Arguments are passed as given, without a shell.

## Good to know

- Only `.exe` tools can be started on Windows without a shell. Tools installed as `.cmd` scripts are not supported
  there yet.
- `deploy init` writes files atomically and refuses links and paths outside the project, like
  [mayura init](init.md).
- Use `--directory <dir>` to work on a project other than the current directory.

## Related

- [Deployment](../guides/deployment.md): the targets, roles and production settings behind these files.
- [Serve, worker and migrate](run.md): the commands each container runs.
