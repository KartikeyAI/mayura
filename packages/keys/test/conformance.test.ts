import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { createSqliteStore } from '@mayura/storage';
import { keyManagerConformance, memoryAggregateStore } from '../src/testing.js';

describe('key manager conformance: memory store', () => {
  for (const test of keyManagerConformance) {
    it(test.name, async () => { const store = memoryAggregateStore(); await store.initialize(); await test.run({ store }); });
  }
});

describe('key manager conformance: SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mayura-keys-'));
  afterAll(() => { rmSync(directory, { recursive: true, force: true }); });
  let count = 0;
  for (const test of keyManagerConformance) {
    it(test.name, async () => {
      const store = createSqliteStore({ filename: join(directory, `keys-${++count}.sqlite`) });
      await store.initialize();
      try { await test.run({ store }); } finally { await store.close(); }
    });
  }
});
