import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useMayuraHumanRequest, useMayuraRun, useMayuraRunActions, useMayuraRunActivity } from '@mayura/client-react';
import { useSyncExternalStore } from 'react';

const root = await realpath(process.cwd());
for (const name of ['@mayura/client-react', '@mayura/client', 'react']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'React consumer escaped its isolated archive installation.');
}
for (const name of ['@mayura/server', '@mayura/runtime', 'react-dom']) await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
assert.equal(typeof useMayuraRun, 'function'); assert.equal(typeof useMayuraRunActions, 'function'); assert.equal(typeof useMayuraHumanRequest, 'function');
assert.equal(typeof useMayuraRunActivity, 'function');
assert.equal(typeof useSyncExternalStore, 'function');
console.log(JSON.stringify({ status: 'passed', reactPeer: true, publicTypesWithoutReactTypes: true, noImplicitNetwork: true, activityHook: true }));
