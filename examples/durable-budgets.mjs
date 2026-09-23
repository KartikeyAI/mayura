import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from '@mayura/storage-sqlite';

// A financial-ledger fixture only: these test charges are not model/tool executions.
const directory = await mkdtemp(join(tmpdir(), 'mayura-durable-budget-example-'));
const filename = join(directory, 'budget.sqlite');
const key = { scope: 'example', id: 'shared-budget', policyHash: 'a'.repeat(64) };
const reservation = { ...key, accountId: 'review', reservationId: 'primary' };
let store;
try {
  store = createSqliteStore({ filename }); await store.initialize(); await store.durableBudgets.initialize();
  await store.durableBudgets.create({ ...key, maxCostMicros: 10, maxCalls: 4 });
  await store.durableBudgets.fork({ ...key, parentId: 'root', accountId: 'review', maxCostMicros: 6, maxCalls: 2 });
  await store.durableBudgets.reserveBundle({ ...key, accountId: 'review', bundleId: 'review-pair',
    operations: [{ id: 'primary', maxCostMicros: 4 }, { id: 'check', maxCostMicros: 2 }] });
  const started = await store.durableBudgets.start(reservation);
  if (started.status !== 'started') throw new Error('A fresh reservation should start once.');
  await store.durableBudgets.markUnknown(reservation);
  const closed = await store.durableBudgets.closeSubtree({ ...key, accountId: 'review' });
  const before = closed.accounts.find(account => account.id === 'root');
  if (before.reservedMicros !== 4 || before.calls !== 1 || before.heldCalls !== 0) throw new Error('Closure must preserve unknown cost and release only held work.');
  await store.close();

  store = createSqliteStore({ filename }); await store.initialize(); await store.durableBudgets.initialize();
  if ((await store.durableBudgets.start(reservation)).status !== 'already_started') throw new Error('Restart must never turn a historical start into a new dispatch permission.');
  // The trusted host supplies confirmed evidence; the ledger cannot infer a provider bill.
  const known = await store.durableBudgets.settle({ ...reservation, actualMicros: 3 });
  const after = known.snapshot.accounts.find(account => account.id === 'root');
  if (known.overrun || after.spentMicros !== 3 || after.reservedMicros !== 0 || after.calls !== 1) throw new Error('Late known cost must settle after closure.');
  console.log(JSON.stringify({ unknownReservedMicros: before.reservedMicros, afterReopen: { spentMicros: after.spentMicros, reservedMicros: after.reservedMicros, calls: after.calls }, effectsExecuted: false }));
} finally {
  await store?.close();
  const cleanup = resolve(directory);
  if (!cleanup.startsWith(`${resolve(tmpdir())}${sep}mayura-durable-budget-example-`)) throw new Error('Unexpected example fixture path.');
  await rm(cleanup, { recursive: true, force: true });
}
