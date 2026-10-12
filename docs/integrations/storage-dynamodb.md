---
title: "Amazon DynamoDB storage"
description: "Keep Mayura's workflows, jobs, memory, budgets and API keys in one Amazon DynamoDB table with @mayurajs/storage-dynamodb."
package: "@mayurajs/storage-dynamodb"
vendor: "Amazon Web Services"
logo: "aws"
website: "https://aws.amazon.com/dynamodb/"
area: "storage"
---

[Amazon DynamoDB](https://aws.amazon.com/dynamodb/) is AWS's serverless key-value and document database.
`@mayurajs/storage-dynamodb` is a Mayura [store](../guides/storage.md) in one DynamoDB table. It holds everything the SQL
stores hold: run records and their events (the server's submission journal and run records), durable workflows with
their graphs, trees, waits and discovery, the leased job scheduler, durable budgets, native memory and
[API keys](../guides/authentication.md#api-keys). It talks to DynamoDB through the official
`@aws-sdk/client-dynamodb`, pinned at 3.1141.0, its only dependency, and sends the SDK's requests with `fetch` rather
than Node's HTTP stack.

## Install

```bash
npm install mayura @mayurajs/storage-dynamodb
```

## Credentials

Create an IAM user or role for the store in the [IAM console](https://console.aws.amazon.com/iam/), with an access key,
or give it temporary credentials from your own STS call. The store uses these DynamoDB actions on its table:

- `dynamodb:DescribeTable`, at `initialize()`;
- `dynamodb:GetItem`, `dynamodb:BatchGetItem` and `dynamodb:Query` to read (strongly consistent);
- `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem` and `dynamodb:ConditionCheckItem`, which a
  `TransactWriteItems` commit needs;
- `dynamodb:CreateTable`, only with `createTable: true`.

Nothing is read from the environment, AWS config files or instance metadata: pass the region and credentials yourself,
for example from `AWS_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, and the table name from
`DYNAMODB_TABLE`.

## Use it

```ts
import { createNativeMemory } from 'mayura/memory';
import { createDynamoStore } from '@mayurajs/storage-dynamodb';

const store = createDynamoStore({
  table: process.env.DYNAMODB_TABLE ?? 'mayura',
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '' },
});
await store.initialize();          // checks the table's key schema
await store.memory.initialize();

const memory = createNativeMemory({
  store,
  scope: { principalId: 'customer-42', projectId: 'support' },
  permissions: { allow: ['memory:read', 'memory:write'] },
});

// Hand `store` to workflow runtimes, durable budgets, the key manager and your server too.
await store.close();
```

`credentials` may also be a function that returns fresh ones, called when the SDK needs them:

```ts
import { createDynamoStore } from '@mayurajs/storage-dynamodb';

const store = createDynamoStore({
  table: 'mayura',
  region: 'eu-west-1',
  credentials: async () => ({ accessKeyId: 'ASIA...', secretAccessKey: '...', sessionToken: '...', expiration: new Date(Date.now() + 3_600_000) }),
});
```

To use a `DynamoDBClient` you configure yourself, pass it as `client` instead of `region` and `credentials`. The store
never destroys a client you gave it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `table` | required | The table: 3 to 255 letters, digits, `_`, `-` and `.`, with string partition key `p` and string sort key `s`. |
| `region` | required, or `client` | The AWS region, such as `us-east-1`. |
| `credentials` | required, or `client` | `{ accessKeyId, secretAccessKey, sessionToken? }`, or a function returning them. |
| `endpoint` | `https://dynamodb.<region>.amazonaws.com` | Another endpoint, such as a VPC endpoint: https only, or http on a loopback address (DynamoDB Local). No credentials, query or fragment. |
| `fetch` | `globalThis.fetch` | The fetch that sends requests, for tests and proxies. |
| `client` | none | A `DynamoDBClient` you create and own, instead of `region`, `credentials`, `endpoint` and `fetch`. |
| `createTable` | `false` | Create the table with on-demand capacity when it does not exist. Creating tables is a grant you give deliberately. |
| `retryForMs` | 30,000 | How long a transaction keeps running again after conflicts before it fails, from 0 to 600,000 ms. |

The store's own client signs with SigV4, makes up to 3 attempts per request in the SDK's standard retry mode, and
uses neither FIPS nor dual-stack endpoints. Any other option fails with `INVALID_INPUT` when you call
`createDynamoStore()`.

## Setup and migrations

`initialize()` checks that the table has a string partition key `p` and a string sort key `s`. When the table does not
exist, it fails unless you passed `createTable: true`; then it creates the table with on-demand billing and waits up to
a minute for it to become active. Every document lives in that one table, so each feature's own `initialize()` only
marks it ready. See [Migrations](../guides/storage.md#migrations) for how layout changes ship.

## Transactions and concurrency

DynamoDB has no interactive transactions. The store runs Mayura's state machines as optimistic transactions:

- A transaction reads with strongly consistent reads and holds its writes.
- It commits one `TransactWriteItems` in which every action expects the version its transaction saw, so it applies
  whole or not at all.
- If a condition fails or DynamoDB reports a transaction conflict, the transaction runs again with fresh reads after a
  short random pause, for up to `retryForMs`. Two writers of one record never both succeed.
- DynamoDB has no clock to read, so leases and deadlines use your hosts' clocks: keep them synchronized.

Under heavy contention on one record, transactions run again rather than wait; different records never contend. Every
call is a round trip, so run your service in the table's region. Memory search scans a scope's term index and ranks it
in your process, so it grows with the number of records in the scope. See
[D1 and DynamoDB](../guides/storage.md#d1-and-dynamodb).

## Limits

- An item is at most 400 KB, so a document larger than 350,000 bytes is split into chunk items stored beside it and
  read back in one snapshot.
- One transaction writes at most 100 items, chunk items included. An operation that needs more fails whole with
  `LIMIT_EXCEEDED` instead of partly applying. The largest operations, such as a graph that waits on 128 different
  runs, can reach that limit.

## Errors

Failures reach you as a `StorageError` with a `storageCode`; messages never contain the SDK's text or your credentials.
See [Errors](../guides/storage.md#errors) for every code.

| `storageCode` | When |
| --- | --- |
| `INVALID_INPUT` | An option is missing, unknown or malformed, such as a region that is not one, an `http://` endpoint to another host, or both `client` and `credentials`; or the table's key schema is not `p` and `s`. |
| `CONFLICT` | A record changed after it was read, or an id or idempotency key already holds other content. |
| `LIMIT_EXCEEDED` | One operation would write more than 100 items in a transaction. |
| `STORAGE_UNAVAILABLE` | The table does not exist (and `createTable` is off) or did not become active, concurrent writers kept changing the same records for longer than `retryForMs`, or DynamoDB failed. |
| `STORE_NOT_INITIALIZED` | A call came before `await store.initialize()`. |
| `STORE_CLOSED` | A call came after `close()`. |

## How it is tested

- Unit tests run the store against a fake DynamoDB that records every request: it signs with the credentials and region
  given, sends to the endpoint given, accepts http only on a loopback address, reports a failing service without its
  text, and reads nothing from `AWS_*` environment variables.
- In CI, against DynamoDB Local in a container (`MAYURA_TEST_DYNAMODB_URL`), each fixture in a table of its own: every
  storage, memory and workflow conformance suite the SQL stores pass, including crash tests that kill a process just
  before or after a commit. That is records, the key manager, identity integrity, scheduled bounds, memory and native
  memory, workflows, the scheduler, scheduled workflows, graphs, graph discovery and coordination, execution waits,
  durable budgets and workflow trees.
- It has not been run against a hosted AWS account yet.

## Related

- [Storage](../guides/storage.md#d1-and-dynamodb): how D1 and DynamoDB run optimistic transactions.
- [Cloudflare D1](storage-d1.md): the same document store on D1.
- [Files](../guides/files.md#s3-and-s3-compatible-services): files in S3 with the same kind of explicit credentials.
- [Durable workflows](../guides/durable-workflows.md): what runs on the store.
