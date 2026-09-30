# @mayurajs/storage-dynamodb

Mayura storage on Amazon DynamoDB, through the official AWS SDK: everything the SQL stores keep, in one table.

```bash
npm install mayura @mayurajs/storage-dynamodb
```

```ts
import { createDynamoStore } from '@mayurajs/storage-dynamodb';

const store = createDynamoStore({ table: 'mayura', region: 'us-east-1', credentials });
await store.initialize();
```

- The table has a string partition key `p` and string sort key `s`. `createTable: true` creates it (on-demand capacity)
  when it is missing; nothing is created otherwise.
- Region and credentials are options: nothing is read from the environment, AWS config files or instance metadata.
  Requests go through `fetch`, so the store runs wherever fetch does. Or pass a `DynamoDBClient` you own as `client`.
- Mayura's state machines run as optimistic transactions: each reads consistently, holds its writes, and commits one
  `TransactWriteItems` that applies only if nothing it locked or wrote changed; otherwise it runs again.
- DynamoDB has no clock to read: leases use your hosts' clocks, so keep them synchronized. Documents over 400 KB are
  split into chunk items; an operation that needs more than DynamoDB's 100 items per transaction fails whole with
  `LIMIT_EXCEEDED`.

See the [storage guide](https://mayurajs.com/docs/guides/storage/). Apache-2.0.
