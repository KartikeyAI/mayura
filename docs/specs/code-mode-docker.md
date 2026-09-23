# Docker Code Mode outer adapter

Status: experimental local containment profile; not hostile-code production qualification.

`@mayura/adapter-code-docker` launches the `@mayura/adapter-code-quickjs` worker protocol inside a disposable Linux container. It does not expose Docker to guest code. Nested tools still cross the JSON protocol and the ordinary Mayura broker; the container receives no SDK client, credential, host environment, network, host mount or Docker socket.

## Image construction

Build the workspace, then run `pnpm code-sandbox:image`. `MAYURA_DOCKER_CLI` may specify a trusted absolute CLI path. The command creates a retained directory under `.artifacts/code-sandbox-image-*`, copies the compiled worker and the exact QuickJS dependency closure, builds without network or pulling, and emits `report.json` plus the exact local image ID.

The Dockerfile pins the Node Alpine base by manifest digest and fixes the runtime identity to `65532:65532`. Consumers must independently control image provenance, signing, scanning, retention and promotion. A local image ID proves only which local content Docker will execute; it is not a publisher signature.

## Runtime contract

Construct the adapter with `{ dockerPath, image }`, where `dockerPath` is absolute and `image` matches `sha256:<64 lowercase hex characters>`. Availability succeeds only when a bounded exact-image inspection returns the same ID. Execution never pulls.

Every container has:

- no network and no shared IPC;
- read-only root and no host bind mounts;
- non-root UID/GID 65532;
- all Linux capabilities dropped, no-new-privileges and Docker's built-in seccomp profile;
- one CPU, 16 PIDs, 64 open files, and equal memory/memory-swap ceilings;
- one bounded `/tmp` `tmpfs` with `noexec`, `nosuid` and `nodev`; and
- an empty process environment from the host adapter.

Memory includes a fixed outer-runtime allowance in addition to the program's QuickJS heap limit and remains capped. Scratch space maps only to `/tmp`; the current JavaScript guest has no filesystem API. Programs support the same JSON-only JavaScript subset and empty import catalog as the QuickJS adapter.

## Failure and testing

Protocol corruption, Docker startup failure, image mismatch, resource exhaustion, abnormal exit and removal races return sanitized failures. Cancellation returns the Code Mode cancellation outcome and asynchronously force-removes the exact randomly named container. No host execution fallback exists.

Live tests require `MAYURA_TEST_DOCKER_PATH` and `MAYURA_TEST_CODE_SANDBOX_IMAGE`. Without both variables, the Docker integration file is skipped and supplies no containment evidence. The current live matrix is one Docker Desktop Linux/amd64 environment. V15 remains open for authoritative external reconciliation, exact promoted host-action approvals, broader host qualification, escape evaluation and production image supply-chain controls.
