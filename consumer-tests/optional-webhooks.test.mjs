import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebhookRuntime, defineWebhookTrigger } from '@mayura/workstream/webhooks';

const root = await realpath(process.cwd());
for (const name of ['@mayura/workstream/webhooks', '@mayura/core', '@mayura/storage-contracts']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Webhook consumer escaped its isolated archive installation.');
}
for (const name of ['@mayura/storage', '@mayura/storage-sqlite', '@mayura/storage-postgres', 'better-sqlite3', 'pg', '@mayura/runtime', '@mayura/workflows']) {
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
await assert.rejects(import('@mayura/workstream/src/webhooks.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });

let record; const history = []; const stamp = '2026-09-24T00:00:00.000Z'; const copy = value => structuredClone(value);
const store = {
  initialize: async () => {}, close: async () => {},
  create: async command => {
    if (record) return { record: copy(record), created: false };
    record = { scope: command.scope, id: command.id, idempotencyKey: command.idempotencyKey, version: 1, definitionHash: command.definitionHash, state: copy(command.state) };
    for (const input of command.events) history.push({ sequence: history.length + 1, type: input.type, data: copy(input.data), createdAt: stamp });
    return { record: copy(record), created: true };
  },
  read: async (scope, id) => record?.scope === scope && record.id === id ? copy(record) : undefined,
  update: async command => {
    assert(record && record.scope === command.scope && record.id === command.id && record.version === command.expectedVersion);
    record = { ...record, version: record.version + 1, state: copy(command.state) };
    for (const input of command.events) history.push({ sequence: history.length + 1, type: input.type, data: copy(input.data), createdAt: stamp });
    return copy(record);
  },
  events: async (scope, id, after = 0) => record?.scope === scope && record.id === id ? copy(history.filter(event => event.sequence > after)) : [],
};
const secret = Buffer.alloc(32, 7); let now = 1_000; let calls = 0;
const schema = { '~standard': { version: 1, vendor: 'packed-webhook', validate: value => value?.action === 'release' ? { value } : { issues: [{ message: 'invalid' }] } } };
const trigger = defineWebhookTrigger({ id: 'deploy', version: '1.0.0', secretId: 'deploy-secret', schemaId: 'deploy-v1', schemaDigest: 'a'.repeat(64), input: schema,
  dispatch: input => { calls++; return { accepted: input.action }; } });
const runtime = createWebhookRuntime({ store, scope: { principalId: 'consumer', projectId: 'app' }, now: () => now, resolveSecret: async () => secret });
const request = timestampMs => { const body = new TextEncoder().encode('{"action":"release"}');
  return { deliveryId: 'delivery-1', timestampMs, body, signature: `sha256=${createHmac('sha256', secret).update(`${timestampMs}.delivery-1.`).update(body).digest('hex')}` }; };
const first = await runtime.receive(trigger, request(now)); now = 1_500; const retry = await runtime.receive(trigger, request(now));
assert.equal(first.status, 'succeeded'); assert.deepEqual(first.output, { accepted: 'release' }); assert.deepEqual(retry, first); assert.equal(calls, 1);
assert.deepEqual((await runtime.events(first.id)).map(event => event.type), ['webhook.admitted', 'webhook.dispatching', 'webhook.succeeded']);
console.log(JSON.stringify({ status: 'passed', driverFree: true, authenticated: true, deduplicated: true, sqlDriversInstalled: false }));
