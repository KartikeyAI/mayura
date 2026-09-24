# Disposable PostgreSQL integration tests

The repository's `compose.test.yaml` is test-only, binds to localhost and uses an in-memory database directory. Its public fixture password is not a deployment secret. Stopping this service loses test data. Never point the suite at production: tests create and drop their own randomly named schemas.

With Docker Desktop running Linux containers, from the repository:

```sh
docker compose -f compose.test.yaml up -d --wait
```

Set the test-process environment variable. In PowerShell:

```powershell
$env:MAYURA_TEST_POSTGRES_URL = 'postgresql://mayura:mayura_local_test_only@127.0.0.1:55258/mayura'
pnpm typecheck
pnpm test
pnpm test:consumer:storage
```

In a POSIX shell:

```sh
MAYURA_TEST_POSTGRES_URL='postgresql://mayura:mayura_local_test_only@127.0.0.1:55258/mayura' pnpm test
```

Afterward, stop only this test project:

```sh
docker compose -f compose.test.yaml down
```

If port 55258 is occupied, stop the conflicting fixture deliberately or choose another localhost port and update the URL. Never stop unrelated containers or prune global Docker data. A fresh machine may need to download the pinned image. Pinning is not a vulnerability audit; see [technology qualification](technology-qualification.md).

CI uses a separate ephemeral service. SQLite tests use isolated temporary files. Process/client restart is tested; engine/host crash consistency and backup/restore still need the broader release matrix.

The test runner defaults to two concurrent test processes. This limits contention among independent fsync-heavy, process-kill and short-lease fixtures; explicit competing-worker scenarios inside a test are unchanged. Run additional archive gates after the full suite, not concurrently with it. Recorded timing-sensitive failures and qualification limits are retained in the [development ledger](development-status.md).

## Code Mode sandbox image

Build the workspace and the pinned local image, then copy the exact `image` and `provenance` values from the retained report:

```powershell
pnpm build
pnpm code-sandbox:image
$env:MAYURA_TEST_DOCKER_PATH = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$env:MAYURA_TEST_CODE_SANDBOX_IMAGE = 'sha256:<exact-local-image-id>'
$env:MAYURA_TEST_CODE_SANDBOX_PROVENANCE = 'sha256:<exact-SPDX-document-digest>'
node node_modules/vitest/vitest.mjs run packages/adapter-code-docker/test/docker.integration.test.ts --maxWorkers=1
```

The build retains `report.json` and `root/sbom.spdx.json` under `.artifacts/code-sandbox-image-*`. The runtime verifies both the exact image ID and its provenance label. This local SPDX inventory is not image signing, a vulnerability/license scan or production host qualification.

The optional strict promotion factory additionally verifies a canonical `mayura-docker-promotion-v1` statement with an application-pinned Ed25519 public key. The statement binds this exact image/provenance pair to a fresh scan with zero critical, high and unknown findings. The focused live suite signs a statement with a disposable test key and runs the real image through that factory; production must supply its own qualified scanner, protected signer, key distribution, revocation and evidence-retention pipeline. See the [promotion contract](specs/code-mode-docker-promotion.md).

`pnpm test:consumer:storage` additionally installs real local archives into fresh SQLite-only, PostgreSQL-only, compatibility and workflow-tree-plus-SQLite consumers, with lifecycle scripts and registry access disabled. The workflow-tree profile proves an approval-enabled root-local-to-required-child path after database close/reopen. When the explicit test URL is present, the two PostgreSQL-capable profiles create/drop only their own generated `mayura_packed_…` schemas. Without it, their database execution is reported as skipped, not qualified; both SQLite native-worker profiles can still run. Generated archives, installed consumers and SQLite fixture files stay under an ignored `.artifacts/storage-consumer-*` directory for inspection.
