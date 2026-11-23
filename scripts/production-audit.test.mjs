import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePolicy, productionFindings, productionInventory } from './production-audit.mjs';

function fixture() {
  const common = {
    name: 'shared', manifest: { name: '@mayurajs/shared', dependencies: { extension: '1.0.0' } },
  };
  const consumer = {
    name: 'consumer', manifest: { name: '@mayurajs/consumer', dependencies: { '@mayurajs/shared': 'workspace:*' } },
  };
  const workspace = [{
    name: 'sdk', manifest: { dependencies: { zod: '4.6.7', 'extra-peer': '1.0.0' } },
  }];
  const lock = {
    lockfileVersion: '9.0',
    importers: {
      'packages/sdk': {
        dependencies: { zod: { specifier: '4.6.7', version: '4.6.7' } },
        devDependencies: { dev: { specifier: '1.0.0', version: '1.0.0' } },
      },
      'extensions/shared': { dependencies: { extension: { specifier: '1.0.0', version: '1.0.0(workspace-peer@1.0.0)' } } },
      'extensions/consumer': { dependencies: { '@mayurajs/shared': { specifier: 'workspace:*', version: 'link:../shared' } } },
    },
    packages: {
      'zod@4.6.7': {}, 'platform-binary@1.0.0': {}, 'published-alias@1.0.0': {},
      'extension@1.0.0': { peerDependenciesMeta: { 'workspace-peer': { optional: true } } },
    },
    snapshots: {
      'zod@4.6.7': {},
      'platform-binary@1.0.0': {},
      'published-alias@1.0.0': {},
      'extension@1.0.0(workspace-peer@1.0.0)': {
        dependencies: { alias: 'published-alias@1.0.0' },
        optionalDependencies: { 'platform-binary': '1.0.0', 'workspace-peer': '1.0.0' },
      },
    },
  };
  return { lock, workspace, extensions: [common, consumer] };
}

test('includes published production dependencies, aliases, platform optionals and workspace links', () => {
  const { lock, workspace, extensions } = fixture();
  const { roots, versions } = productionInventory(lock, workspace, extensions);
  const dependencies = ['extension@1.0.0', 'platform-binary@1.0.0', 'published-alias@1.0.0', 'zod@4.6.7'];
  assert.deepEqual([...roots.get('mayura')], ['zod@4.6.7']);
  assert.deepEqual([...roots.get('@mayurajs/shared')].sort(), dependencies);
  assert.deepEqual([...roots.get('@mayurajs/consumer')].sort(), dependencies);
  assert.deepEqual([...versions.keys()].sort(), ['extension', 'platform-binary', 'published-alias', 'zod']);
});

test('refuses a missing snapshot and a mismatched locked manifest', () => {
  const { lock, workspace, extensions } = fixture();
  delete lock.snapshots['published-alias@1.0.0'];
  assert.throws(() => productionInventory(lock, workspace, extensions), /Missing lockfile snapshot/u);
  workspace[0].manifest.dependencies.zod = '4.6.8';
  assert.throws(() => productionInventory(lock, workspace, extensions), /Missing locked dependency/u);
});

test('submits exactly the production inventory to npm and identifies every affected publication', async () => {
  const { lock, workspace, extensions } = fixture();
  const inventory = productionInventory(lock, workspace, extensions);
  const report = await productionFindings(inventory, async (url, options) => {
    assert.equal(new URL(url).hostname, 'registry.npmjs.org');
    assert.deepEqual(JSON.parse(options.body), { extension: ['1.0.0'], 'platform-binary': ['1.0.0'], 'published-alias': ['1.0.0'], zod: ['4.6.7'] });
    return Response.json({
      extension: [
        { id: 11, severity: 'high', vulnerable_versions: '>=1.0.0 <1.0.1' },
        { id: 12, severity: 'moderate', vulnerable_versions: '<1.0.0' },
      ],
    });
  });
  assert.deepEqual(report, [{ id: 11, severity: 'high', name: 'extension', version: '1.0.0', affected: ['@mayurajs/shared', '@mayurajs/consumer'] }]);
  await assert.rejects(productionFindings(inventory, async () => new Response('', { status: 503 })), /HTTP 503/u);
  await assert.rejects(productionFindings(inventory, async () => Response.json([])), /Invalid npm audit response/u);
  await assert.rejects(productionFindings(inventory, async () => Response.json({ extension: [{ id: 11, severity: 'new', vulnerable_versions: '*' }] })), /Invalid npm advisory/u);
});

test('blocks high and critical findings and requires a verified, expiring exception for moderate findings', async () => {
  const finding = { name: 'extension', version: '1.0.0', id: 41, severity: 'moderate' };
  const review = 'https://github.com/KartikeyAI/mayura/pull/1#pullrequestreview-2';
  const exception = { name: 'extension', version: '1.0.0', id: 41, reason: 'Fixture risk assessment', review, expiresOn: '2026-12-01' };
  const policy = { version: 1, exceptions: [exception] };
  const now = Date.parse('2026-11-23T00:00:00Z');
  const high = { ...finding, severity: 'high' };
  const critical = { ...finding, severity: 'critical' };
  const differentVersion = { ...finding, version: '1.0.1' };
  const result = await evaluatePolicy([finding, high, critical, differentVersion, { ...finding, severity: 'low' }], policy, {
    now,
    approved: async approval => {
      assert.deepEqual(approval, { review, marker: 'Approve moderate extension@1.0.0 npm:41 until 2026-12-01' });
      return true;
    },
  });
  assert.deepEqual(result.blocked, [high, critical, differentVersion]);
  assert.deepEqual(result.excepted, [{ ...finding, expiresOn: '2026-12-01' }]);
  assert.deepEqual((await evaluatePolicy([finding], policy, { now, approved: async () => false })).blocked, [finding]);
  assert.deepEqual((await evaluatePolicy([finding], { version: 1, exceptions: [] }, { now })).blocked, [finding]);
  await assert.rejects(evaluatePolicy([], policy, { now: Date.parse('2026-12-01T00:00:00Z') }), /Expired exception/u);
  await assert.rejects(evaluatePolicy([], { version: 1, exceptions: [{ ...exception, expiresOn: '2027-02-30' }] }, { now }), /Invalid UTC expiry/u);
});
