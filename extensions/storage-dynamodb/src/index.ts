import {
  BatchGetItemCommand, CreateTableCommand, DescribeTableCommand, DynamoDBClient, QueryCommand, TransactGetItemsCommand, TransactWriteItemsCommand,
  type AttributeValue, type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { StorageError, storageError } from 'mayura/storage-contracts';
import { createDocumentStore, documentRangeBounds, type DocumentBackend, type DocumentStore, type DocumentWrite, type StoredDocument } from 'mayura/storage-sql/host';

/** The Mayura store on Amazon DynamoDB. */
export type DynamoStore = DocumentStore;
/** AWS credentials, or a function that returns fresh ones (for example from your own STS call). */
export type DynamoAwsCredentials =
  | { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
  | (() => Promise<{ readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string; readonly expiration?: Date }>);
export interface DynamoStoreOptions {
  /** The table that holds Mayura's documents: string partition key `p` and string sort key `s`. */
  readonly table: string;
  /** The AWS region, such as `us-east-1`. Required with `credentials`: nothing is read from the environment or AWS config files. */
  readonly region?: string;
  /** Signs requests (SigV4). Give these and `region`, or `client`. */
  readonly credentials?: DynamoAwsCredentials;
  /**
   * Send requests here instead of https://dynamodb.<region>.amazonaws.com, for example a VPC endpoint. https only,
   * except `http://` on a loopback address (DynamoDB Local).
   */
  readonly endpoint?: string;
  /** The fetch that sends requests; the global fetch by default. */
  readonly fetch?: typeof globalThis.fetch;
  /** A DynamoDBClient you create and own, instead of `region` and `credentials`. The store never destroys it. */
  readonly client?: DynamoDBClient;
  /** Create the table (on-demand capacity) when it does not exist. Off by default: creating tables is a deliberate grant. */
  readonly createTable?: boolean;
  /** How long a transaction keeps running again after conflicts before failing; 30 seconds by default. */
  readonly retryForMs?: number;
}

/** Items are at most 400 KB: bodies larger than this are split into chunk items beside them. */
const CHUNK_BYTES = 350_000;
/** Chunk items live in a sibling partition no encoded partition key can equal, so partition reads never see them. */
const chunks = (partition: string) => `${partition}\u0001\u0002`;
const chunkSort = (sort: string, index: number) => `${sort}${String(index).padStart(4, '0')}`;
const MAX_ITEMS = 100;
const encoder = new TextEncoder();
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });

const decoder = new TextDecoder('utf-8', { fatal: true });
/** Splits text into parts of at most `CHUNK_BYTES` UTF-8 bytes, never inside a character. */
function split(text: string): string[] {
  if (text.length * 3 <= CHUNK_BYTES) return [text];
  const bytes = encoder.encode(text);
  if (bytes.length <= CHUNK_BYTES) return [text];
  const parts: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + CHUNK_BYTES);
    // Back up to a character's first byte: continuation bytes are 10xxxxxx.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(decoder.decode(bytes.subarray(start, end))); start = end;
  }
  return parts;
}
function failed(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored document failed integrity validation.'); }
function item(value: Record<string, AttributeValue> | undefined): { partition: string; sort: string; version: number; body: string; count: number } | undefined {
  if (!value) return undefined;
  const version = Number(value['v']?.N); const count = value['n'] ? Number(value['n'].N) : 1;
  if (typeof value['p']?.S !== 'string' || typeof value['s']?.S !== 'string' || typeof value['b']?.S !== 'string' || !Number.isSafeInteger(version) || !Number.isSafeInteger(count) || count < 1) failed();
  return { partition: value['p'].S, sort: value['s'].S, version, body: value['b'].S, count };
}

/**
 * The DynamoDB half of Mayura's optimistic document store. Reads are strongly consistent; a commit is one
 * TransactWriteItems whose every action expects the version its transaction saw, so it applies whole or not at all.
 * DynamoDB has no server clock: leases and deadlines use this host's clock, so keep every host's clock synchronized.
 */
export function dynamoBackend(client: DynamoDBClient, table: string, options: { createTable?: boolean } = {}): DocumentBackend {
  /** Chunk counts by document version, from reads, so a commit knows which old chunks to remove. */
  const counts = new Map<string, { version: number; count: number }>();
  const id = (partition: string, sort: string) => `${partition}\u0000${sort}`;
  /** A document whose body spans chunks, read with its chunks in one snapshot. */
  const whole = async (head: NonNullable<ReturnType<typeof item>>): Promise<StoredDocument | undefined> => {
    counts.set(id(head.partition, head.sort), { version: head.version, count: head.count });
    if (head.count === 1) return { partition: head.partition, sort: head.sort, version: head.version, body: head.body };
    const keys = [{ p: S(head.partition), s: S(head.sort) }, ...Array.from({ length: head.count - 1 }, (_, index) => ({ p: S(chunks(head.partition)), s: S(chunkSort(head.sort, index + 1)) }))];
    const result = await client.send(new TransactGetItemsCommand({ TransactItems: keys.map(Key => ({ Get: { TableName: table, Key } })) }));
    const [first, ...rest] = (result.Responses ?? []).map(response => response.Item);
    const current = item(first); if (!current) return undefined;
    if (current.count !== head.count) return whole(current);
    if (rest.some(part => part?.['v']?.N !== String(current.version) || typeof part?.['b']?.S !== 'string')) failed();
    counts.set(id(current.partition, current.sort), { version: current.version, count: current.count });
    return { partition: current.partition, sort: current.sort, version: current.version, body: current.body + rest.map(part => part!['b']!.S!).join('') };
  };
  const pages = async (partition: string, range: Parameters<DocumentBackend['query']>[1], select?: 'COUNT') => {
    const { lower, upper: above, through } = documentRangeBounds(range);
    // BETWEEN is inclusive: `above` never occurs as a key, so it bounds the range exactly.
    const upper = through === undefined ? above : through;
    const found: Record<string, AttributeValue>[] = []; let total = 0; let start: Record<string, AttributeValue> | undefined;
    do {
      const result = await client.send(new QueryCommand({ TableName: table, ConsistentRead: true, KeyConditionExpression: 'p = :p AND s BETWEEN :lower AND :upper',
        ExpressionAttributeValues: { ':p': S(partition), ':lower': S(lower), ':upper': S(upper) }, ScanIndexForward: !range.reverse,
        ...(select ? { Select: select } : {}), ...(range.limit === undefined || select ? {} : { Limit: range.limit - found.length }), ...(start ? { ExclusiveStartKey: start } : {}) }));
      found.push(...(result.Items ?? [])); total += result.Count ?? 0; start = result.LastEvaluatedKey;
    } while (start && (select || range.limit === undefined || found.length < range.limit));
    return { found, total };
  };
  return {
    initialize: async () => {
      try {
        const description = await client.send(new DescribeTableCommand({ TableName: table }));
        const schema = description.Table?.KeySchema ?? [];
        const attributes = new Map((description.Table?.AttributeDefinitions ?? []).map(attribute => [attribute.AttributeName, attribute.AttributeType]));
        if (schema.length !== 2 || !schema.some(key => key.AttributeName === 'p' && key.KeyType === 'HASH') || !schema.some(key => key.AttributeName === 's' && key.KeyType === 'RANGE')
          || attributes.get('p') !== 'S' || attributes.get('s') !== 'S') {
          throw new StorageError('INVALID_INPUT', `DynamoDB table ${table} must have a string partition key p and a string sort key s.`);
        }
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error;
        if (!options.createTable) throw new StorageError('STORAGE_UNAVAILABLE', `DynamoDB table ${table} does not exist: create it, or pass createTable: true.`);
        await client.send(new CreateTableCommand({ TableName: table, BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'p', AttributeType: 'S' }, { AttributeName: 's', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'p', KeyType: 'HASH' }, { AttributeName: 's', KeyType: 'RANGE' }] })).catch((created: unknown) => {
          if (!(created instanceof Error) || created.name !== 'ResourceInUseException') throw created;
        });
        for (let attempt = 0; attempt < 120; attempt++) {
          if ((await client.send(new DescribeTableCommand({ TableName: table }))).Table?.TableStatus === 'ACTIVE') return;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new StorageError('STORAGE_UNAVAILABLE', `DynamoDB table ${table} did not become active.`);
      }
    },
    // DynamoDB has no clock to read: this host's wall clock, without Date.now, which callers may replace.
    clock: async () => Math.round(performance.timeOrigin + performance.now()),
    get: async keys => {
      const found = new Map<string, StoredDocument>();
      const unique = [...new Map(keys.map(key => [id(key.partition, key.sort), key])).values()];
      for (let offset = 0; offset < unique.length; offset += 100) {
        let pending: Record<string, AttributeValue>[] = unique.slice(offset, offset + 100).map(key => ({ p: S(key.partition), s: S(key.sort) }));
        for (let attempt = 0; pending.length; attempt++) {
          const result = await client.send(new BatchGetItemCommand({ RequestItems: { [table]: { Keys: pending, ConsistentRead: true } } }));
          for (const raw of result.Responses?.[table] ?? []) {
            const head = item(raw)!; const document = await whole(head);
            if (document) found.set(id(document.partition, document.sort), document);
          }
          pending = result.UnprocessedKeys?.[table]?.Keys ?? [];
          if (pending.length) await new Promise(resolve => setTimeout(resolve, Math.min(1_000, 20 * 2 ** attempt)));
        }
      }
      return keys.map(key => found.get(id(key.partition, key.sort)));
    },
    query: async (partition, range) => {
      const documents: StoredDocument[] = [];
      for (const raw of (await pages(partition, range)).found) { const document = await whole(item(raw)!); if (document) documents.push(document); }
      return documents;
    },
    count: async (partition, range) => (await pages(partition, { prefix: range.prefix, ...(range.after === undefined ? {} : { after: range.after }), ...(range.through === undefined ? {} : { through: range.through }) }, 'COUNT')).total,
    commit: async (writes: readonly DocumentWrite[]) => {
      const actions: TransactWriteItem[] = [];
      const split0 = new Map<DocumentWrite, string[]>();
      const pieces = (write: Extract<DocumentWrite, { kind: 'put' }>) => { let found = split0.get(write); if (!found) { found = split(write.body); split0.set(write, found); } return found; };
      const key = (partition: string, sort: string) => ({ p: S(partition), s: S(sort) });
      const expect = (expected: number | null) => expected === null
        ? { ConditionExpression: 'attribute_not_exists(p)' }
        : { ConditionExpression: 'v = :expected', ExpressionAttributeValues: { ':expected': N(expected) } };
      const oldCount = (write: DocumentWrite) => {
        if (write.expected === null) return 1;
        const known = counts.get(id(write.partition, write.sort));
        return known && known.version === write.expected ? known.count : 1;
      };
      for (const write of writes) {
        if (write.kind === 'put') {
          const [first, ...rest] = pieces(write);
          actions.push({ Put: { TableName: table, Item: { ...key(write.partition, write.sort), v: N(write.version), b: S(first!), ...(rest.length ? { n: N(rest.length + 1) } : {}) }, ...expect(write.expected) } });
          rest.forEach((part, index) => actions.push({ Put: { TableName: table, Item: { ...key(chunks(write.partition), chunkSort(write.sort, index + 1)), v: N(write.version), b: S(part) } } }));
          for (let index = rest.length + 1; index < oldCount(write); index++) actions.push({ Delete: { TableName: table, Key: key(chunks(write.partition), chunkSort(write.sort, index)) } });
        } else if (write.kind === 'bump') {
          actions.push({ Update: { TableName: table, Key: key(write.partition, write.sort), UpdateExpression: 'SET v = :version',
            ConditionExpression: 'v = :expected', ExpressionAttributeValues: { ':version': N(write.version), ':expected': N(write.expected) } } });
          // A chunked document's chunks carry its version: raise theirs too.
          for (let index = 1; index < oldCount(write); index++) actions.push({ Update: { TableName: table, Key: key(chunks(write.partition), chunkSort(write.sort, index)),
            UpdateExpression: 'SET v = :version', ExpressionAttributeValues: { ':version': N(write.version) } } });
        } else if (write.kind === 'delete') {
          actions.push({ Delete: { TableName: table, Key: key(write.partition, write.sort), ...expect(write.expected) } });
          for (let index = 1; index < oldCount(write); index++) actions.push({ Delete: { TableName: table, Key: key(chunks(write.partition), chunkSort(write.sort, index)) } });
        } else actions.push({ ConditionCheck: { TableName: table, Key: key(write.partition, write.sort), ...expect(write.expected) } as never });
      }
      if (actions.length > MAX_ITEMS) throw new StorageError('LIMIT_EXCEEDED', `This operation writes ${actions.length} DynamoDB items in one transaction; DynamoDB allows ${MAX_ITEMS}.`);
      try {
        await client.send(new TransactWriteItemsCommand({ TransactItems: actions }));
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'TransactionInProgressException' || name === 'TransactionConflictException') return false;
        if (name === 'TransactionCanceledException') {
          const reasons = ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map(reason => reason.Code ?? 'None');
          if (reasons.some(code => code === 'ConditionalCheckFailed' || code === 'TransactionConflict') && reasons.every(code => ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(code))) return false;
        }
        throw error;
      }
      for (const write of writes) {
        if (write.kind === 'put') counts.set(id(write.partition, write.sort), { version: write.version, count: pieces(write).length });
        else if (write.kind === 'bump') { const known = counts.get(id(write.partition, write.sort)); if (known) counts.set(id(write.partition, write.sort), { version: write.version, count: known.count }); }
        else if (write.kind === 'delete') counts.delete(id(write.partition, write.sort));
      }
      return true;
    },
  };
}

/** A fetch-based transport, so the store runs wherever fetch does. */
function fetchHandler(transport: () => typeof globalThis.fetch) {
  return {
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(request: { method: string; protocol: string; hostname: string; port?: number; path: string; query?: Record<string, string | string[] | null>; headers: Record<string, string>; body?: unknown },
      options: { abortSignal?: AbortSignal } = {}) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(request.query ?? {})) for (const item of Array.isArray(value) ? value : [value]) query.append(name, item ?? '');
      const url = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${request.path}${query.size ? `?${query}` : ''}`;
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())));
      const response = await transport()(url, { method: request.method, headers, redirect: 'error',
        ...(request.body === undefined || request.body === null ? {} : { body: request.body as BodyInit }), ...(options.abortSignal ? { signal: options.abortSignal } : {}) });
      const responseHeaders: Record<string, string> = {}; response.headers.forEach((value, name) => { responseHeaders[name] = value; });
      return { response: { statusCode: response.status, reason: response.statusText, headers: responseHeaders,
        body: response.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) } };
    },
    updateHttpClientConfig() { /* nothing to configure */ },
    httpHandlerConfigs() { return {}; },
    destroy() { /* nothing to release */ },
  };
}
function endpointOf(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new StorageError('INVALID_INPUT', 'DynamoDB endpoint must be a URL.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new StorageError('INVALID_INPUT', 'DynamoDB endpoint must be https, or http on a loopback address.');
  if (url.username || url.password || url.search || url.hash) throw new StorageError('INVALID_INPUT', 'DynamoDB endpoint must not carry credentials, a query or a fragment.');
  return url.origin + url.pathname.replace(/\/$/u, '');
}

/**
 * A DynamoDBClient configured only from these options: nothing is read from the environment, AWS config files or
 * instance metadata. Requests go through `fetch`, so it runs wherever fetch does.
 */
export function dynamoClient(options: { readonly region: string; readonly credentials: DynamoAwsCredentials; readonly endpoint?: string; readonly fetch?: typeof globalThis.fetch }): DynamoDBClient {
  if (typeof options.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/u.test(options.region)) throw new StorageError('INVALID_INPUT', 'DynamoDB needs a region, such as us-east-1.');
  const credentials = options.credentials;
  if (typeof credentials !== 'function' && (!credentials || typeof credentials.accessKeyId !== 'string' || !credentials.accessKeyId || typeof credentials.secretAccessKey !== 'string' || !credentials.secretAccessKey)) {
    throw new StorageError('INVALID_INPUT', 'DynamoDB credentials need an accessKeyId and a secretAccessKey.');
  }
  const endpoint = options.endpoint === undefined ? `https://dynamodb.${options.region}.amazonaws.com` : endpointOf(options.endpoint);
  return new DynamoDBClient({
    // Every setting the SDK would otherwise look up in the environment, AWS config files or instance metadata.
    region: options.region, endpoint, useFipsEndpoint: false, useDualstackEndpoint: false, defaultsMode: 'standard', maxAttempts: 3, retryMode: 'standard',
    userAgentAppId: 'mayura', credentials, authSchemePreference: ['sigv4'], accountIdEndpointMode: 'disabled',
    requestHandler: fetchHandler(() => options.fetch ?? globalThis.fetch) as never,
  } as never);
}

/**
 * The Mayura store on Amazon DynamoDB: everything the SQL stores keep, as optimistic transactions over one table. The
 * region and credentials are options: nothing is read from the environment, AWS config files or instance metadata.
 *
 * ```ts
 * const store = createDynamoStore({ table: 'mayura', region: 'us-east-1', credentials });
 * await store.initialize();
 * ```
 */
export function createDynamoStore(options: DynamoStoreOptions): DynamoStore {
  const allowed = ['table', 'region', 'credentials', 'endpoint', 'fetch', 'client', 'createTable', 'retryForMs'];
  if (options === null || typeof options !== 'object' || Object.keys(options).some(key => !allowed.includes(key))) throw new StorageError('INVALID_INPUT', `DynamoDB store options are ${allowed.join(', ')}.`);
  if (typeof options.table !== 'string' || !/^[A-Za-z0-9_.-]{3,255}$/u.test(options.table)) throw new StorageError('INVALID_INPUT', 'DynamoDB table must be a table name of 3 to 255 letters, digits, _, - and .');
  if (options.retryForMs !== undefined && (!Number.isSafeInteger(options.retryForMs) || options.retryForMs < 0 || options.retryForMs > 600_000)) throw new StorageError('INVALID_INPUT', 'DynamoDB retryForMs must be an integer from 0 to 600000.');
  let client: DynamoDBClient;
  if (options.client !== undefined) {
    if (!(options.client instanceof DynamoDBClient)) throw new StorageError('INVALID_INPUT', 'DynamoDB client must be a DynamoDBClient.');
    if (options.region !== undefined || options.credentials !== undefined || options.endpoint !== undefined || options.fetch !== undefined) {
      throw new StorageError('INVALID_INPUT', 'Give either a DynamoDB client, or region and credentials.');
    }
    client = options.client;
  } else client = dynamoClient(options as { region: string; credentials: DynamoAwsCredentials; endpoint?: string; fetch?: typeof globalThis.fetch });
  return createDocumentStore(dynamoBackend(client, options.table, { createTable: options.createTable === true }), {
    ...(options.retryForMs === undefined ? {} : { retryForMs: options.retryForMs }),
    failure: error => error instanceof StorageError ? error : storageError(error),
    ...(options.client === undefined ? { close: async () => { client.destroy(); } } : {}),
  });
}
