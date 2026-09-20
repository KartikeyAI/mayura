import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecutionWorkStream } from '@mayura/workstream/executions';
import { executionRef, executionWaitHashMaterial, workflowHashMaterial } from '@mayura/storage-contracts';

const root = await realpath(process.cwd());
for (const name of ['@mayura/workstream/executions', '@mayura/core', '@mayura/storage-contracts']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Completion consumer escaped its isolated archive installation.');
}
for (const name of ['@mayura/storage', 'better-sqlite3', 'pg', '@mayura/runtime', '@mayura/workflows', '@mayura/server', '@mayura/testing']) {
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
await assert.rejects(import('@mayura/workstream/src/executions.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const hash = value => createHash('sha256').update(value).digest('hex');
const scope = { principalId: 'consumer', projectId: 'app' };
const target = executionRef({ kind: 'scheduled-workflow', runId: 'a'.repeat(64), definitionHash: 'b'.repeat(64), policyHash: 'c'.repeat(64) });
const key = { scope: hash(workflowHashMaterial('mayura:scope:v1', scope)), streamId: 'joins', policyHash: target.policyHash };
let stored; let ready = false; let closes = 0; let drains = 0;
const history = [{ sequence: 1, type: 'stream.created', data: {}, createdAt: '2026-09-20T00:00:00.000Z' }];
// This is intentionally an in-process contract fixture, not a durable implementation.
const store = { close: async () => { closes++; }, executionWaits: {
  initialize: async () => {}, open: async command => { assert.deepEqual(command, key); }, materialize: async () => undefined,
  register: async command => {
    assert.deepEqual(command, { ...key, id: 'release', targets: [target] });
    if (!stored) {
      stored = { id: command.id, version: 1, definitionHash: hash(executionWaitHashMaterial(key, command.id, command.targets)), status: 'waiting', targets: command.targets, observations: [] };
      history.push({ sequence: 2, type: 'wait.registered', data: { waitId: command.id }, createdAt: history[0].createdAt });
    }
    return stored;
  },
  inspect: async () => stored,
  cancel: async () => { throw new Error('Not exercised by this fixture.'); },
  drainReady: async command => {
    drains++; assert.deepEqual(command, { ...key, limit: 16 });
    if (!ready || stored.status !== 'waiting') return [];
    stored = { ...stored, version: 2, status: 'resolved', observations: [{ reference: target, outcome: 'outcome_unknown', sourceVersion: 7, sourceEventSequence: 11 }] };
    history.push({ sequence: 3, type: 'wait.resolved', data: { waitId: stored.id }, createdAt: history[0].createdAt });
    return [stored];
  }, events: async command => history.filter(event => event.sequence > command.after),
} };
const stream = createExecutionWorkStream({ store, scope, policyHash: target.policyHash, streamId: key.streamId });
await stream.initialize();
assert.equal((await stream.register({ id: 'release', targets: [target] })).status, 'waiting');
assert.deepEqual(await stream.drainReady(), []); ready = true;
const page = await stream.drainReady(); assert.equal(page[0].observations[0].outcome, 'outcome_unknown');
assert.equal(page[0].version, 2); assert(Object.isFrozen(page[0].observations[0]));
assert.deepEqual(await stream.drainReady(), []); assert.equal((await stream.events()).length, 3);
await stream.close(); assert.equal(closes, 0);
const reopened = createExecutionWorkStream({ store, scope, policyHash: target.policyHash, streamId: key.streamId });
await reopened.initialize(); assert.equal((await reopened.inspect('release')).status, 'resolved'); await reopened.close();
console.log(JSON.stringify({ status: 'passed', sqlDriversInstalled: false, customAdapter: true, drains, terminalOutcome: 'outcome_unknown', events: history.length }));
