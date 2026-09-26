// PostgreSQL backup/restore drill against the disposable test database container (compose.test.yaml).
//   MAYURA_TEST_POSTGRES_URL=... node scripts/postgres-restore-drill.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPostgresStore } from '@mayura/storage-postgres';

const exec = promisify(execFile);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const connectionString = process.env.MAYURA_TEST_POSTGRES_URL;
assert(connectionString, 'Set MAYURA_TEST_POSTGRES_URL to the disposable test database.');
const docker = (...args) => exec('docker', args, { timeout: 120_000, windowsHide: true });
const container = (await docker('ps', '--filter', 'label=io.mayura.purpose=integration-test', '--format', '{{.Names}}')).stdout.trim().split(/\r?\n/)[0];
assert(container, 'The compose.test.yaml PostgreSQL container is not running.');
const suffix = randomBytes(6).toString('hex'); const schema = `drill_${suffix}`; const database = `drill_restore_${suffix}`;
const record = id => ({ scope: 'drill', id, idempotencyKey: id, definitionHash: 'a'.repeat(64), state: { value: id }, events: [{ type: 'created', data: {} }] });
const psql = (db, sql) => docker('exec', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'mayura', '-d', db, '-c', sql);
const restoredUrl = new URL(connectionString); restoredUrl.pathname = `/${database}`;
const report = { schema, database, steps: [] };
try {
  const source = createPostgresStore({ connectionString, schema }); await source.initialize();
  await source.create(record('before-backup')); report.steps.push('wrote-before-backup');
  // Custom-format dump of exactly this store's schema, inside the database container.
  await docker('exec', container, 'pg_dump', '-U', 'mayura', '-d', 'mayura', '-Fc', '-n', schema, '-f', `/tmp/${schema}.dump`); report.steps.push('dumped');
  await source.create(record('after-backup')); await source.close(); report.steps.push('wrote-after-backup');
  await docker('exec', container, 'createdb', '-U', 'mayura', database);
  await docker('exec', container, 'pg_restore', '-U', 'mayura', '-d', database, '--exit-on-error', `/tmp/${schema}.dump`); report.steps.push('restored');
  const restored = createPostgresStore({ connectionString: restoredUrl.href, schema }); await restored.initialize();
  assert.deepEqual((await restored.read('drill', 'before-backup'))?.state, { value: 'before-backup' });
  assert.equal(await restored.read('drill', 'after-backup'), undefined);
  assert.equal((await restored.create(record('after-restore'))).created, true);
  await restored.close(); report.steps.push('verified'); report.status = 'passed';
} finally {
  await docker('exec', container, 'rm', '-f', `/tmp/${schema}.dump`).catch(() => {});
  await psql('mayura', `DROP DATABASE IF EXISTS ${database}`).catch(() => {});
  await psql('mayura', `DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
}
const output = await mkdtemp(join(workspace, '.artifacts', 'restore-drill-')); await mkdir(output, { recursive: true });
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, report: relative(workspace, join(output, 'report.json')) }));
