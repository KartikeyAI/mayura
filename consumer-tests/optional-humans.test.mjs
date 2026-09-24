import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHumanWorkStream } from '@mayura/workstream/humans';

const root = await realpath(process.cwd());
for (const name of ['@mayura/workstream/humans', '@mayura/core', '@mayura/storage-contracts']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Human-request consumer escaped its isolated archive installation.');
}
for (const name of ['@mayura/storage', '@mayura/storage-sqlite', '@mayura/storage-postgres', 'better-sqlite3', 'pg', '@mayura/runtime', '@mayura/workflows']) {
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
await assert.rejects(import('@mayura/workstream/src/humans.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });

let record; const history = []; const stamp = '2026-09-24T00:00:00.000Z';
const copy = value => structuredClone(value);
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
    assert(record && record.scope === command.scope && record.id === command.id);
    if (record.version !== command.expectedVersion) { const error = new Error('conflict'); error.code = 'CONFLICT'; throw error; }
    record = { ...record, version: record.version + 1, state: copy(command.state), updatedAt: stamp };
    for (const input of command.events) history.push({ sequence: history.length + 1, type: input.type, data: copy(input.data), createdAt: stamp });
    return copy(record);
  },
  events: async (scope, id, after = 0) => record?.scope === scope && record.id === id ? copy(history.filter(event => event.sequence > after)) : [],
};
const response = { '~standard': { version: 1, vendor: 'packed-consumer', validate: value => value?.choice === 'accept' ? { value: { choice: value.choice } } : { issues: [{ message: 'invalid' }] } } };
const definition = { id: 'review', kind: 'plan_selection', schemaId: 'choice-v1', schemaDigest: 'a'.repeat(64), prompt: 'Select the next plan.', response };
let authorizationCalls = 0;
const options = { store, scope: { principalId: 'consumer', projectId: 'app' }, streamId: 'reviews', authorize: input => {
  authorizationCalls++; assert(Object.isFrozen(input)); assert(Object.isFrozen(input.request)); return input.actor.id === 'reviewer';
} };
const first = createHumanWorkStream(options); await first.initialize();
assert.equal((await first.request(definition)).status, 'waiting');
const restarted = createHumanWorkStream(options); await restarted.initialize();
const answered = await restarted.respond(definition, { commandId: 'answer', actor: { id: 'reviewer' }, value: { choice: 'accept' } });
assert.equal(answered.status, 'answered'); assert.equal(answered.response.value.choice, 'accept'); assert(Object.isFrozen(answered.response));
assert.equal((await first.inspect(definition)).status, 'answered');
console.log(JSON.stringify({ status: 'passed', driverFree: true, restartSafe: true, typedResponse: true, authorizationCalls, sqlDriversInstalled: false }));
