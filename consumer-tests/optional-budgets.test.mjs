import assert from 'node:assert/strict';
import { durableBudgetCommand, durableBudgetSnapshot, StorageError } from '@mayura/storage-contracts';

for (const name of ['@mayura/storage', '@mayura/storage-sql', '@mayura/storage-sqlite', '@mayura/storage-postgres',
  '@mayura/runtime', '@mayura/workflows', 'better-sqlite3', 'pg']) {
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
await assert.rejects(import('@mayura/storage-contracts/src/durable-budget-contracts.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const key = { scope: 'packed-budget', id: 'root-ledger', policyHash: 'a'.repeat(64) };
const command = { ...key, accountId: 'root', bundleId: 'pair', operations: [{ id: 'primary', maxCostMicros: 3 }] };
const admitted = durableBudgetCommand('reserveBundle', command);
command.operations[0].maxCostMicros = 100;
assert.equal(admitted.operations[0].maxCostMicros, 3);
assert(Object.isFrozen(admitted)); assert(Object.isFrozen(admitted.operations[0]));
const raw = { ...key, format: 1, mode: 'shared-ceiling-v1', owner: 'host-v1', version: 1, eventSequence: 1, blocked: false,
  accounts: [{ id: 'root', parentId: null, maxCostMicros: 10, maxCalls: 4, closed: false, spentMicros: 0, reservedMicros: 0, calls: 0, heldCalls: 0 }],
  bundles: [], reservations: [] };
// A driver-free custom-adapter boundary, not a substitute for real persistence tests.
const snapshot = durableBudgetSnapshot(raw);
raw.accounts[0].spentMicros = 5;
assert.equal(snapshot.accounts[0].spentMicros, 0); assert(Object.isFrozen(snapshot.accounts[0]));
assert.throws(() => durableBudgetSnapshot(raw), error => error instanceof StorageError && error.code === 'STORAGE_UNAVAILABLE');
let getters = 0;
const accessor = Object.defineProperty({}, 'scope', { enumerable: true, get() { getters++; return key.scope; } });
assert.throws(() => durableBudgetCommand('inspect', accessor), error => error instanceof StorageError && error.code === 'INVALID_INPUT');
assert.equal(getters, 0);
assert.throws(() => durableBudgetCommand('settle', { ...key, accountId: 'root', reservationId: 'primary', actualMicros: -1 }),
  error => error instanceof StorageError && error.code === 'INVALID_INPUT');
assert.throws(() => durableBudgetCommand('inspect', { ...key, id: '\ud800' }),
  error => error instanceof StorageError && error.code === 'INVALID_INPUT');
assert.equal(durableBudgetCommand('inspect', { ...key, id: '\u{1f680}' }).id, '\u{1f680}');
console.log(JSON.stringify({ status: 'passed', driverFree: true, immutableCommands: true, immutableSnapshots: true,
  forgedAccountingRejected: true, executesEffects: false }));
