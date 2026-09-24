import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTimerWorkStream } from '@mayura/workstream/timers';

const root = await realpath(process.cwd());
for (const name of ['@mayura/workstream/timers', '@mayura/core', '@mayura/storage-contracts']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Timer consumer escaped its isolated archive installation.');
}
for (const name of ['@mayura/storage', '@mayura/storage-sqlite', '@mayura/storage-postgres', 'better-sqlite3', 'pg', '@mayura/runtime', '@mayura/workflows']) {
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
await assert.rejects(import('@mayura/workstream/src/timers.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });

let record; const history = []; const stamp = '2026-09-24T00:00:00.000Z'; const copy = value => structuredClone(value);
const store = {
  initialize: async () => {}, close: async () => {},
  create: async command => {
    if (record) return { record: copy(record), created: false };
    record = { scope: command.scope, id: command.id, version: 1, definitionHash: command.definitionHash, state: copy(command.state), createdAt: stamp, updatedAt: stamp };
    for (const input of command.events) history.push({ sequence: history.length + 1, type: input.type, data: copy(input.data), createdAt: stamp });
    return { record: copy(record), created: true };
  },
  read: async (scope, id) => record?.scope === scope && record.id === id ? copy(record) : undefined,
  update: async command => {
    assert(record && record.scope === command.scope && record.id === command.id && record.version === command.expectedVersion);
    record = { ...record, version: record.version + 1, state: copy(command.state), updatedAt: stamp };
    for (const input of command.events) history.push({ sequence: history.length + 1, type: input.type, data: copy(input.data), createdAt: stamp });
    return copy(record);
  },
  events: async (scope, id, after = 0) => record?.scope === scope && record.id === id ? copy(history.filter(event => event.sequence > after)) : [],
};
let now = 1_000; const options = { store, scope: { principalId: 'consumer', projectId: 'app' }, streamId: 'timers', now: () => now };
const first = createTimerWorkStream(options); await first.initialize(); await first.schedule({ id: 'wake', dueAtMs: 2_000, payload: { run: 'a' } });
assert.deepEqual(await first.sweepDue(), []); now = 2_500;
const restarted = createTimerWorkStream(options); await restarted.initialize();
const fired = await restarted.sweepDue(); assert.equal(fired[0].status, 'fired'); assert.equal(fired[0].firedAtMs, now); assert(Object.isFrozen(fired[0]));
assert.deepEqual(await first.sweepDue(), []); assert.equal((await first.events()).filter(event => event.type === 'timer.fired').length, 1);
console.log(JSON.stringify({ status: 'passed', driverFree: true, restartSafe: true, firesOnce: true, sqlDriversInstalled: false }));
