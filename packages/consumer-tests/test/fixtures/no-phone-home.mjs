import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url); const attempts = [];
const denied = name => (..._arguments) => { attempts.push(name); throw new Error('Unexpected network attempt.'); };
globalThis.fetch = denied('fetch');
globalThis.WebSocket = class { constructor() { attempts.push('WebSocket'); throw new Error('Unexpected network attempt.'); } };
for (const [name, methods] of [['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']], ['node:dgram', ['createSocket']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']]]) {
  const module = require(name);
  for (const method of methods) module[method] = denied(`${name}.${method}`);
}
syncBuiltinESMExports();

const packages = ['@mayura/core', '@mayura/cli', '@mayura/helpers', '@mayura/tools', '@mayura/runtime', '@mayura/sdk', '@mayura/testing', '@mayura/workflows',
  '@mayura/workstream', '@mayura/storage-contracts', '@mayura/context', '@mayura/memory', '@mayura/guardrails',
  '@mayura/observability', '@mayura/code-mode', '@mayura/code-mode-workflows', '@mayura/adapter-code-quickjs', '@mayura/adapter-code-docker',
  '@mayura/artifacts'];
const workspace = new URL('../../../../', import.meta.url);
await Promise.all(packages.map(name => import(new URL(`packages/${name.slice(8)}/dist/index.js`, workspace).href)));
await new Promise(resolve => setTimeout(resolve, 100));
assert.deepEqual(attempts, []);
console.log(JSON.stringify({ status: 'passed', packages: packages.length, networkAttempts: attempts.length }));
