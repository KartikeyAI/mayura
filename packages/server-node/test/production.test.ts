import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { listenProductionServer, type ProductionAgentServer, type ProductionServerOptions } from '../src/index.js';
import { defineAgent } from '../../runtime/dist/index.js';
import type { ModelResponse, Schema } from '../../core/src/index.js';
import type { ServerIdentity } from '../../server/src/index.js';

// Self-signed, test-only material for localhost/127.0.0.1. It protects nothing and is not a secret.
const key = readFileSync(new URL('./fixtures/test-only-localhost.key', import.meta.url));
const cert = readFileSync(new URL('./fixtures/test-only-localhost.crt', import.meta.url));
const numberSchema: Schema<number> = { '~standard': { version: 1, vendor: 'fixture', validate: value => typeof value === 'number' ? { value } : { issues: [{ message: 'number required' }] } } };
const identity = (): ServerIdentity => ({ scope: { principalId: 'operator', projectId: 'production-host' }, agentIds: ['prod.agent'],
  capabilities: ['runs:read', 'runs:submit'], expiresAtMs: Date.now() + 60_000 });
const hosts = new Set<ProductionAgentServer>();
afterEach(async () => { await Promise.all([...hosts].map(host => host.close())); hosts.clear(); });

function options(overrides: Partial<ProductionServerOptions> = {}): ProductionServerOptions {
  const agent = defineAgent({ id: 'prod.agent', version: '1', instructions: 'Production host fixture.', input: numberSchema, output: numberSchema, tools: [],
    model: { id: 'prod.model', capabilities: { tools: false, structuredOutput: true }, maxCostMicros: 0,
      generate: async (): Promise<ModelResponse> => ({ type: 'final', output: 4, usage: { costMicros: 0 } }) } });
  return { agents: [{ agent, permissions: { allow: ['model:prod.model'] } }], authenticate: async ({ token }) => token === 'fixture-token' ? identity() : null,
    publicOrigin: 'https://api.example.test', hostname: '127.0.0.1', port: 0, tls: { terminatedBy: 'proxy' }, shutdownGraceMs: 50, ...overrides };
}
async function start(overrides: Partial<ProductionServerOptions> = {}) { const host = await listenProductionServer(options(overrides)); hosts.add(host); return host; }
interface Reply { readonly status: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: string }
function call(port: number, input: { path: string; host?: string; method?: string; token?: string; body?: string; tls?: boolean; idempotencyKey?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: input.host ?? 'api.example.test' };
    if (input.token) headers['authorization'] = `Bearer ${input.token}`;
    if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;
    if (input.body !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(input.body)); }
    const settings = { hostname: '127.0.0.1', port, path: input.path, method: input.method ?? 'GET', headers };
    const done = (response: import('node:http').IncomingMessage) => { let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body })); };
    const request = input.tls ? httpsRequest({ ...settings, ca: cert, servername: 'localhost' }, done) : httpRequest(settings, done);
    request.on('error', reject); if (input.body !== undefined) request.write(input.body); request.end();
  });
}

describe('production Node host', () => {
  it('refuses ambiguous or insecure configuration before binding', async () => {
    for (const bad of [{ publicOrigin: 'http://api.example.test' }, { publicOrigin: 'https://api.example.test/base' }, { publicOrigin: 'https://user@api.example.test' },
      { tls: undefined as never }, { tls: { terminatedBy: 'proxy', key } as never }, { tls: { key: '', cert } }, { hostname: '' }, { port: 70_000 },
      { shutdownGraceMs: 0 }, { readiness: 'yes' as never }]) {
      await expect(listenProductionServer(options(bad))).rejects.toThrow();
    }
  });

  it('serves content-free probes to any host and only canonical-host traffic to the protocol behind a proxy', async () => {
    const host = await start(); expect(host.isAccepting()).toBe(true); expect(host.publicOrigin).toBe('https://api.example.test');
    for (const probe of ['/livez', '/readyz']) {
      const reply = await call(host.port, { path: probe, host: '10.0.0.7:8080' }); expect(reply.status).toBe(200); expect(reply.headers['cache-control']).toBe('no-store');
    }
    const agents = await call(host.port, { path: '/v1/agents', token: 'fixture-token' });
    expect(agents.status).toBe(200); expect(JSON.parse(agents.body)).toEqual({ agents: [{ id: 'prod.agent', version: '1' }] });
    expect(agents.headers['strict-transport-security']).toBe('max-age=31536000');
    const misdirected = await call(host.port, { path: '/v1/agents', token: 'fixture-token', host: 'attacker.example.test' });
    expect(misdirected.status).toBe(421); expect(misdirected.body).toContain('MISDIRECTED_REQUEST'); expect(misdirected.body).not.toContain('prod.agent');
    expect((await call(host.port, { path: '/v1/agents' })).status).toBe(401);
    const submitted = await call(host.port, { path: '/v1/runs', method: 'POST', token: 'fixture-token', body: JSON.stringify({ agentId: 'prod.agent', input: 2 }), idempotencyKey: 'proxy-run' });
    expect([200, 201, 202]).toContain(submitted.status); expect(JSON.parse(submitted.body)).toMatchObject({ id: expect.any(String) });
  });

  it('accepts a rewritten Host only from a trusted proxy that names the public host in X-Forwarded-Host', async () => {
    const internal = { path: '/v1/agents', token: 'fixture-token', host: 'agents.internal:8080' };
    const forwarded = (headers: Record<string, string>) => (port: number) => new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: '/v1/agents', headers: { host: 'agents.internal:8080', authorization: 'Bearer fixture-token', ...headers } },
        response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
      request.on('error', reject); request.end();
    });
    // Without trust, a forwarding header changes nothing: the Host must be the public host.
    const plain = await start();
    expect((await call(plain.port, internal)).status).toBe(421);
    expect(await forwarded({ 'x-forwarded-host': 'api.example.test' })(plain.port)).toBe(421);
    const other = await start({ trustedProxies: ['10.0.0.9'] });
    expect(await forwarded({ 'x-forwarded-host': 'api.example.test' })(other.port)).toBe(421);
    // The test client connects from 127.0.0.1 (possibly as an IPv4-mapped IPv6 address).
    const trusted = await start({ trustedProxies: ['127.0.0.1'] });
    expect(await forwarded({ 'x-forwarded-host': 'api.example.test' })(trusted.port)).toBe(200);
    expect(await forwarded({ 'x-forwarded-host': 'client-supplied.example, api.example.test' })(trusted.port)).toBe(200);
    expect(await forwarded({ 'x-forwarded-host': 'attacker.example.test' })(trusted.port)).toBe(421);
    expect((await call(trusted.port, { path: '/v1/agents', token: 'fixture-token' })).status).toBe(200);
    const refused = await call(trusted.port, internal); expect(refused.status).toBe(421);
    expect(JSON.parse(refused.body)).toEqual({ error: { code: 'MISDIRECTED_REQUEST', message: expect.stringContaining('trustedProxies') } });
    for (const bad of [['proxy.internal'], ['10.0.0.0/8'], 'x' as never]) await expect(listenProductionServer(options({ trustedProxies: bad }))).rejects.toThrow();
  });

  it('passes durable run records through to the protocol', async () => {
    const claim = vi.fn(async () => { throw new Error('PRIVATE store failure'); });
    const unused = async () => { throw new Error('unused'); };
    const host = await start({ runRecords: { claim, release: unused, start: unused, update: unused, read: unused, events: unused, requestCancel: unused, abandon: unused } });
    const refused = await call(host.port, { path: '/v1/runs', method: 'POST', token: 'fixture-token', body: JSON.stringify({ agentId: 'prod.agent', input: 2 }), idempotencyKey: 'records' });
    expect(refused.status).toBe(503); expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'RUN_RECORDS_UNAVAILABLE' } }); expect(claim).toHaveBeenCalledOnce();
    expect(refused.body).not.toContain('PRIVATE');
  });

  it('reports readiness from the application and fails it as soon as shutdown begins', async () => {
    let ready = true; const readiness = vi.fn(async () => { if (ready === null as never) throw new Error('PRIVATE'); return ready; });
    const host = await start({ readiness });
    expect((await call(host.port, { path: '/readyz' })).status).toBe(200); ready = false;
    const notReady = await call(host.port, { path: '/readyz' }); expect(notReady.status).toBe(503); expect(notReady.body).not.toContain('PRIVATE');
    const failing = await start({ readiness: async () => { throw new Error('PRIVATE storage detail'); } });
    const failed = await call(failing.port, { path: '/readyz' }); expect(failed.status).toBe(503); expect(failed.body).not.toContain('PRIVATE');
    const closing = host.close(); expect(host.isAccepting()).toBe(false); await closing; hosts.delete(host);
  });

  it('terminates TLS in-process with an HTTPS-only origin', async () => {
    const host = await start({ tls: { key, cert }, hstsMaxAgeSeconds: 600 });
    const live = await call(host.port, { path: '/livez', tls: true }); expect(live.status).toBe(200);
    const agents = await call(host.port, { path: '/v1/agents', token: 'fixture-token', tls: true });
    expect(agents.status).toBe(200); expect(agents.headers['strict-transport-security']).toBe('max-age=600');
    await expect(call(host.port, { path: '/livez' })).rejects.toBeDefined();
  });
});
