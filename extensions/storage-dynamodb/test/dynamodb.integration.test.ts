// The storage conformance suites against DynamoDB. Set MAYURA_TEST_DYNAMODB_URL to a disposable DynamoDB, for example
// DynamoDB Local:
//   docker run -d -p 127.0.0.1:18000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory -sharedDb
//   MAYURA_TEST_DYNAMODB_URL=http://127.0.0.1:18000
// Every fixture gets its own table, deleted afterwards.
import { randomUUID } from 'node:crypto';
import { DeleteItemCommand, DeleteTableCommand, PutItemCommand, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { createDynamoStore, dynamoBackend, dynamoClient } from '../src/index.js';
import { aggregateConformance } from '../../../packages/storage/test/conformance.js';
import { durableBudgetConformance } from '../../../packages/storage/test/durable-budget-conformance.js';
import { executionWaitConformance } from '../../../packages/storage/test/execution-waits-conformance.js';
import { identityIntegrityConformance } from '../../../packages/storage/test/identity-integrity-conformance.js';
import { scheduledBounds } from '../../../packages/storage/test/scheduled-bounds-conformance.js';
import { schedulerConformance } from '../../../packages/storage/test/scheduler-conformance.js';
import { workflowTreeCapabilityConformance } from '../../../packages/storage/test/workflow-tree-capability-conformance.js';
import { memoryConformance } from '../../../packages/memory/test/conformance.js';
import { nativeMemoryConformance } from '../../../packages/memory/test/native-conformance.js';
import { workflowConformance } from '../../../packages/workflows/test/conformance.js';
import { graphWorkflowConformance } from '../../../packages/workflows/test/graph-conformance.js';
import { graphDiscoveryConformance } from '../../../packages/workflows/test/graph-discovery-conformance.js';
import { graphCoordinatorConformance } from '../../../packages/workflows/test/graph-coordinator-conformance.js';
import { scheduledWorkflowConformance } from '../../../packages/workflows/test/scheduled-conformance.js';
import { workflowTreeRuntimeConformance } from '../../../packages/workflows/test/tree-runtime-conformance.js';
import { workflowTreeCoordinatorConformance } from '../../../packages/workflows/test/tree-coordinator-conformance.js';
import { documentFixtures } from '../../../packages/storage-sql/test/document-fixtures.js';

const endpoint = process.env['MAYURA_TEST_DYNAMODB_URL'];
const local = { region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } };

const fixtures = documentFixtures(async () => {
  const table = `mayura_test_${randomUUID().replaceAll('-', '')}`;
  const client = dynamoClient({ ...local, endpoint: endpoint! });
  const backend = dynamoBackend(client, table, { createTable: true }); await backend.initialize();
  /** Raw items as documents; chunked documents are joined as the backend would read them. */
  const scan = async () => {
    const items: Record<string, AttributeValue>[] = []; let start: Record<string, AttributeValue> | undefined;
    do { const page = await client.send(new ScanCommand({ TableName: table, ConsistentRead: true, ...(start ? { ExclusiveStartKey: start } : {}) })); items.push(...(page.Items ?? [])); start = page.LastEvaluatedKey; } while (start);
    const heads = items.filter(item => !item['p']!.S!.endsWith('\u0001\u0002'));
    return Promise.all(heads.map(async item => (await backend.get([{ partition: item['p']!.S!, sort: item['s']!.S! }]))[0]!));
  };
  return { backend, child: { adapter: 'dynamodb', endpoint: endpoint!, table },
    raw: {
      scan,
      write: async changes => {
        const current = new Map((await scan()).map(document => [`${document.partition}\u0000${document.sort}`, document]));
        for (const change of changes) {
          if (change.body === null) { await client.send(new DeleteItemCommand({ TableName: table, Key: { p: { S: change.partition }, s: { S: change.sort } } })); continue; }
          const version = (current.get(`${change.partition}\u0000${change.sort}`)?.version ?? 0) + 1;
          await client.send(new PutItemCommand({ TableName: table, Item: { p: { S: change.partition }, s: { S: change.sort }, v: { N: String(version) }, b: { S: change.body } } }));
        }
      },
    },
    cleanup: async () => {
      if (!/^mayura_test_[a-f0-9]{32}$/.test(table)) throw new Error('Unexpected DynamoDB fixture table.');
      try { await client.send(new DeleteTableCommand({ TableName: table })); } finally { client.destroy(); }
    } };
});

describe.skipIf(!endpoint)('DynamoDB', () => {
  aggregateConformance('DynamoDB', fixtures.simple);
  identityIntegrityConformance('DynamoDB', fixtures.simple);
  scheduledBounds('DynamoDB', fixtures.simple);
  memoryConformance('DynamoDB', fixtures.simple as never);
  nativeMemoryConformance('DynamoDB', fixtures.simple);
  workflowConformance('DynamoDB', fixtures.simple);
  schedulerConformance('DynamoDB', fixtures.scheduler as never);
  scheduledWorkflowConformance('DynamoDB', fixtures.workflow as never);
  graphWorkflowConformance('DynamoDB', fixtures.workflow as never);
  graphDiscoveryConformance('DynamoDB', fixtures.workflow as never);
  graphCoordinatorConformance('DynamoDB', fixtures.workflow as never);
  executionWaitConformance('DynamoDB', fixtures.waits as never);
  durableBudgetConformance('DynamoDB', fixtures.budgets as never);
  workflowTreeCapabilityConformance('DynamoDB', fixtures.trees as never);
  workflowTreeRuntimeConformance('DynamoDB', fixtures.trees as never);
  workflowTreeCoordinatorConformance('DynamoDB', fixtures.trees as never);

  it('refuses a missing table unless creating it is allowed, and options it cannot use', async () => {
    const table = `mayura_test_${randomUUID().replaceAll('-', '')}`;
    const store = createDynamoStore({ table, ...local, endpoint: endpoint! });
    await expect(store.initialize()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await store.close();
    for (const options of [{}, { table }, { table, region: 'us-east-1' }, { table: 'x', ...local }, { table, ...local, endpoint: 'http://example.com' },
      { table, ...local, endpoint: 'https://user:pass@example.com' }, { table, ...local, extra: 1 }, { table, client: {} }]) {
      expect(() => createDynamoStore(options as never)).toThrow(expect.objectContaining({ storageCode: 'INVALID_INPUT' }));
    }
  });
});
