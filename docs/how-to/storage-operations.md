# Operate Mayura storage: schema versions, migrations, backup and restore

## Schema version policy

Every store records one schema version in `mayura_storage_meta`. **Version 1 is the v1 baseline.** Both adapters refuse to open a store at any other version with `Unsupported storage schema version`, so older code can never write into a newer layout, and a package upgrade never rewrites stored data by itself.

A release that changes the layout ships an explicit, one-way, versioned migration (as `migrateSqliteStoreV0ToV1` did for the 0.1 development layout). Migrations run as their own deployment step, before any new server or worker starts:

```sh
mayura migrate --app ./app.mjs      # calls the application's migrate(), then its shutdown()
```

The application's `migrate()` brings its store to the version the installed packages require and returns a report. In the [reference application](../../examples/deployment/app.mjs) it initializes the version-1 baseline. Always take and verify a backup first; migrations are not reversible.

Stateful workflow runs are separate from the storage layout: definition changes need their own migration policy, because a new package version does not by itself make an old run resumable.

## SQLite

Back up a live store, from a separate read-only connection, through SQLite's online backup API. The copy is consistent even while the application writes, and it is verified (integrity check and schema version) before the call succeeds:

```ts
import { backupSqliteStore, restoreSqliteBackup } from 'mayura/storage';
await backupSqliteStore({ filename: '/data/mayura.sqlite', destination: '/backups/mayura-2026-09-27.sqlite' });
```

To restore, **stop every process that uses the store**, then:

```ts
await restoreSqliteBackup({ backup: '/backups/mayura-2026-09-27.sqlite', filename: '/data/mayura.sqlite' });
```

The backup is verified again, copied to a staging file, the target's write-ahead log is discarded so no newer pages can replay over the restored state, and the staging file atomically replaces the store. Runs whose effects happened after the backup was taken will be missing from the restored store; reconcile them from external evidence rather than replaying them.

## PostgreSQL

Each store lives in one PostgreSQL schema (`schema` option, default `mayura`). Back it up with a custom-format dump of that schema and restore it with `pg_restore`:

```sh
pg_dump -Fc -n mayura -f mayura.dump "$DATABASE_URL"
createdb mayura_restored
pg_restore --exit-on-error -d mayura_restored mayura.dump
```

Point the application at the restored database, run `mayura migrate`, then start servers and workers. `pg_dump` takes a consistent snapshot without stopping the application.

## Restore drills

- `packages/storage/test/backup-restore.sqlite.test.ts` backs up a live SQLite store with committed pages still in its write-ahead log, writes more data, restores, and verifies that exactly the backed-up state returns and the store stays writable; corrupt backups and ambiguous paths are refused without touching the store.
- `MAYURA_TEST_POSTGRES_URL=... node scripts/postgres-restore-drill.mjs` dumps one store schema inside the test database container, writes more data, restores into a fresh database and verifies the same properties. It leaves a report in `.artifacts/restore-drill-*/report.json`.

Run a drill against your own backups on a schedule; an unverified backup is not a backup.
