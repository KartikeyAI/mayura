import { describe, it } from 'vitest';
import { createPostgresStore } from '@mayura/storage';
import { keyManagerConformance } from '../src/testing.js';

// The key manager over the local Postgres (MAYURA_TEST_POSTGRES_URL), a schema of its own per case.
const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];

describe.skipIf(connectionString === undefined)('key manager conformance: Postgres', () => {
  let count = 0;
  for (const test of keyManagerConformance) {
    it(test.name, async () => {
      const store = createPostgresStore({ connectionString: connectionString!, schema: `mayura_keys_${process.pid}_${Date.now()}_${++count}` });
      await store.initialize();
      try { await test.run({ store }); } finally { await store.close(); }
    });
  }
});
