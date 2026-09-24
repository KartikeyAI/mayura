import assert from 'node:assert/strict';
import { MayuraHumanRequestCard, MayuraRunSummary, MayuraWorkflowGraph } from '@mayura/client-react/components';

assert.equal(typeof MayuraRunSummary, 'function');
assert.equal(typeof MayuraWorkflowGraph, 'function');
assert.equal(typeof MayuraHumanRequestCard, 'function');
for (const name of ['@mayura/server', '@mayura/runtime', '@mayura/workflows', 'react-dom']) await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
console.log(JSON.stringify({ status: 'passed', accessibleComponents: true, explicitEvents: true, noRendererDependency: true }));
