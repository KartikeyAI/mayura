import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleExtensions, bundleShard } from './ci-shards.mjs';
import { extensions } from './extensions.mjs';
import { createVitest } from 'vitest/node';

test('Vitest partitions every configured project file without overlaps or omissions', { timeout: 30_000 }, async () => {
  let inventory; const partitions = []; const projects = new Set();
  for (const index of [1, 2]) {
    const context = await createVitest({ run: true, watch: false, shard: `${index}/2` });
    try {
      const specifications = await context.globTestSpecifications();
      const key = specification => `${specification.project.name}:${specification.moduleId}`;
      specifications.forEach(specification => projects.add(specification.project.name));
      const all = specifications.map(key).sort();
      if (inventory) assert.deepEqual(all, inventory); else inventory = all;
      const sequencer = new context.config.sequence.sequencer(context);
      partitions.push((await sequencer.shard(specifications)).map(key));
    } finally { await context.close(); }
  }
  assert(inventory.length > 0);
  assert.deepEqual([...projects].sort(), ['integration', 'unit']);
  assert.deepEqual(partitions.flat().sort(), inventory);
  assert.equal(new Set(partitions.flat()).size, inventory.length);
});

test('every real extension is checked exactly once across the bundle shards', () => {
  const names = extensions().map(extension => extension.name);
  assert.deepEqual(bundleExtensions(names, bundleShard([])), [...names].sort());
  for (const count of [2, 3, 8]) {
    const partitions = Array.from({ length: count }, (_, index) => bundleExtensions(names, bundleShard(['--shard', `${index + 1}/${count}`])));
    assert.deepEqual(partitions.flat().sort(), [...names].sort());
    assert.equal(new Set(partitions.flat()).size, names.length);
    assert(Math.max(...partitions.map(partition => partition.length)) - Math.min(...partitions.map(partition => partition.length)) <= 1);
    for (let index = 0; index < count; index++) {
      assert.deepEqual(bundleExtensions([...names].reverse(), { index: index + 1, count }), partitions[index]);
    }
  }
});

test('malformed shard options and empty or duplicate inventories fail closed', () => {
  for (const args of [['--shard'], ['--shard', '0/2'], ['--shard', '3/2'], ['--shard', '1/9'], ['--shard', '1/2', '--skip'], ['--unknown', '1/2'], ['--shard', '1/2;echo']]) {
    assert.throws(() => bundleShard(args));
  }
  for (const names of [[], ['same', 'same'], ['']]) assert.throws(() => bundleExtensions(names, { index: 1, count: 1 }));
  assert.throws(() => bundleExtensions(['one'], { index: 1, count: 2 }));
});
