import { createPostgresStore } from '@mayura/storage-postgres';
import { createSqliteStore } from '@mayura/storage-sqlite';

// Dedicated test subprocess: stop at a confirmed durable boundary, then the parent kills it.
try {
  const options = JSON.parse(process.env.MAYURA_SCHEDULER_FIXTURE);
  const store = options.adapter === 'sqlite' ? createSqliteStore({ filename: options.filename })
    : options.adapter === 'libsql' ? (await import('./libsql.mjs')).libsqlStore(options)
    : createPostgresStore({ connectionString: options.connectionString, schema: options.schema });
  await store.initialize(); await store.scheduler.initialize();
  const [{ claim }] = await store.scheduler.claim({ scope: 'scheduler-a', workerId: 'crash-worker', limit: 1, leaseMs: 1_000 });
  if (options.phase !== 'claim') await store.scheduler.start({ claim, candidateHash: 'a'.repeat(64) });
  if (options.phase === 'receipt') await store.scheduler.recordReceipt({
    scope: 'scheduler-a', jobId: 'job-a', fence: claim.fence, evidenceId: 'child-evidence',
    receipt: { callId: 'call-a', toolId: 'tool-a', execution: 'succeeded', disclosure: 'withheld' },
  });
  process.stdout.write('ready\n');
  setInterval(() => {}, 1_000);
} catch { process.stderr.write('Scheduler fixture could not reach its durable boundary.\n'); process.exitCode = 1; }
