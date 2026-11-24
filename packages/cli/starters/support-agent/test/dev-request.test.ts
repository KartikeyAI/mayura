import assert from 'node:assert/strict';
import { test } from 'node:test';
import { devRequestTarget, devUpstreamOptions } from '../src/dev-request.js';

const webOrigin = 'http://127.0.0.1:5173';

test('keeps the upstream connection on the configured server and preserves the API path and query', () => {
  const target = devRequestTarget('/v1/runs/example/events?after=2', webOrigin);
  assert(target);
  assert.deepEqual(devUpstreamOptions('http://127.0.0.1:4000', target), {
    protocol: 'http:', hostname: '127.0.0.1', port: '4000', path: '/v1/runs/example/events?after=2',
  });
});

test('rejects request targets outside the local development origin and malformed URLs', () => {
  assert.equal(devRequestTarget('https://other.example/v1/runs', webOrigin), undefined);
  assert.equal(devRequestTarget('http://[', webOrigin), undefined);
  assert.equal(devRequestTarget(undefined, webOrigin)?.pathname, '/');
});
