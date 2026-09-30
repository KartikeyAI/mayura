import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDynamoStore } from '../src/index.js';

const credentials = { accessKeyId: 'AKIDFIXTURE', secretAccessKey: 'fixture-secret' };
type Seen = { url: string; headers: Headers; body: Record<string, unknown> }[];
/** A DynamoDB that knows one table, recording every request. */
function transport(seen: Seen, status = 200): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), headers, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (status !== 200) return new Response(JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#InternalServerError', message: 'busy' }), { status, headers: { 'content-type': 'application/x-amz-json-1.0' } });
    return new Response(JSON.stringify({ Table: { TableName: 'mayura', TableStatus: 'ACTIVE', KeySchema: [{ AttributeName: 'p', KeyType: 'HASH' }, { AttributeName: 's', KeyType: 'RANGE' }],
      AttributeDefinitions: [{ AttributeName: 'p', AttributeType: 'S' }, { AttributeName: 's', AttributeType: 'S' }] } }), { status: 200, headers: { 'content-type': 'application/x-amz-json-1.0' } });
  }) as typeof globalThis.fetch;
}

describe('@mayurajs/storage-dynamodb client', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('signs with the credentials it was given, in its own region, at its own endpoint, and reads nothing from the environment', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1'); vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDFROMENV'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-from-env');
    vi.stubEnv('AWS_ENDPOINT_URL', 'https://attacker.example'); vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', 'https://attacker.example'); vi.stubEnv('AWS_MAX_ATTEMPTS', '9');
    vi.stubEnv('AWS_PROFILE', 'attacker'); vi.stubEnv('AWS_USE_FIPS_ENDPOINT', 'true');
    const seen: Seen = [];
    const store = createDynamoStore({ table: 'mayura', region: 'us-east-1', credentials, fetch: transport(seen) });
    await store.initialize(); await store.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://dynamodb.us-east-1.amazonaws.com/');
    expect(seen[0]!.headers.get('x-amz-target')).toBe('DynamoDB_20120810.DescribeTable');
    expect(seen[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDFIXTURE\/\d{8}\/us-east-1\/dynamodb\/aws4_request/u);
    expect(seen[0]!.body).toEqual({ TableName: 'mayura' });
  });

  it('uses an endpoint it was given, over http only on a loopback address, and reports a failing service without its text', async () => {
    const seen: Seen = [];
    const store = createDynamoStore({ table: 'mayura', region: 'us-east-1', credentials, endpoint: 'http://127.0.0.1:18000', fetch: transport(seen, 400) });
    const failure = await store.initialize().then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(String((failure as Error).message)).not.toContain('busy');
    expect(seen[0]!.url).toBe('http://127.0.0.1:18000/');
    expect(() => createDynamoStore({ table: 'mayura', region: 'us-east-1', credentials, endpoint: 'http://dynamo.example.com' })).toThrow(expect.objectContaining({ storageCode: 'INVALID_INPUT' }));
  });
});
