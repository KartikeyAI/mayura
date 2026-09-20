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
