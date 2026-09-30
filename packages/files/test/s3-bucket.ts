// A disposable bucket on the S3-compatible server named by MAYURA_TEST_S3_URL, for integration tests.
import { createHash } from 'node:crypto';
import type { S3Credentials } from '@mayura/files';
import { signAwsRequest } from '../src/sigv4.js';

/** A fresh bucket on the server, created with a signed CreateBucket request. */
export async function s3TestBucket(url: string, prefix: string): Promise<{ endpoint: string; bucket: string; credentials: S3Credentials }> {
  const parsed = new URL(url);
  const credentials = { accessKeyId: decodeURIComponent(parsed.username), secretAccessKey: decodeURIComponent(parsed.password) };
  const endpoint = `${parsed.protocol}//${parsed.host}`;
  const bucket = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const target = new URL(`${endpoint}/${bucket}`);
  const headers = await signAwsRequest({ method: 'PUT', url: target, query: [], headers: {}, payloadHash: createHash('sha256').update('').digest('hex'),
    region: 'us-east-1', service: 's3', credentials, now: new Date() });
  const response = await fetch(target, { method: 'PUT', headers });
  if (!response.ok) throw new Error(`Creating the test bucket failed with HTTP ${response.status}.`);
  return { endpoint, bucket, credentials };
}
