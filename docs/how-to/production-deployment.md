# Deploy Mayura with containers

This guide runs the [reference deployment application](../../examples/deployment/app.mjs) as one server and several leader-elected workers on PostgreSQL. Adapt the application module; the image, commands and probes stay the same.

## Build the image

```sh
pnpm build
node scripts/server-image.mjs            # add --smoke to run the compose smoke test below
```

The script packs the `mayura` package, `pg` and their reviewed third-party closure (exact versions, no install scripts), installs them offline into a staging directory with the application module, and builds `mayura-server:dev-<id>` with `--network=none` on a digest-pinned `node:24.14.1-alpine` base. The container runs as UID 65532 with `node /app/node_modules/mayura/lib/cli/dist/bin.js` (the `mayura` command) as its entry point and `serve --app /app/app.mjs` as its default command. The report in `.artifacts/server-image-*/report.json` lists every packaged version.

## Run it

| Service | Command | Probe |
|---|---|---|
| Server | `serve --app /app/app.mjs` | `GET :8080/readyz` (and `/livez`) |
| Worker (any number of replicas) | `worker --app /app/app.mjs --probe-host 0.0.0.0 --probe-port 9090` | `GET :9090/readyz` (and `/livez`) |

The reference application reads only environment variables: `DATABASE_URL`, `MAYURA_PUBLIC_ORIGIN` (the exact `https://` origin clients use), `MAYURA_API_TOKEN_SHA256` (SHA-256 of a 64-hex operator token, so the token itself is never in configuration), optional `MAYURA_PROJECT`, `PORT`, `MAYURA_BIND`, `MAYURA_WORKER_ID` (defaults to the container hostname) and `MAYURA_SEED_DUE_AT_MS` (seeds one demonstration reminder; every replica must use the same value).

Put a TLS-terminating proxy or load balancer in front of the server that forwards the original `Host` header; the server refuses any other host with `421`. Point health checks at the probe paths, which are content-free and ignore the host. Give workers a stop grace period longer than `--drain-timeout-ms` (default 30 s): on `SIGTERM` a worker fails readiness, lets admitted effects and receipts settle, releases its leadership lease so a standby takes over immediately, closes storage and exits 0. A second signal forces exit.

## Smoke test

`node scripts/server-image.mjs --smoke` writes a compose project (PostgreSQL, one server, two workers), waits for every health check, and verifies: server readiness; refusal of unauthenticated calls; an authenticated fleet read; a seeded workflow observed waiting and then completed by the leader; two workers started; and, after `docker compose stop`, both workers drained and exited with status 0. The project is always removed afterwards.

## Scope

The image is PostgreSQL-only; SQLite's native driver is intentionally not included. Run `mayura migrate --app /app/app.mjs` as a one-off step before rolling out new servers and workers; schema versions, backups and restore drills are covered in [storage operations](storage-operations.md).
