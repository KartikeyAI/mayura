import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server as NetServer, createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { listenAgentServer, type LocalAgentServer, type LocalServerOptions } from '../src/index.js';
import { createClient } from '../../client/src/index.js';
import { defineAgent } from '../../runtime/dist/index.js';
import type { ModelAdapter, ModelResponse, Schema } from '../../core/src/index.js';
import type { ServerIdentity } from '../../server/src/index.js';

const hosts = new Set<LocalAgentServer>();
const sockets = new Set<Socket>();
const numberSchema: Schema<number> = { '~standard': { version: 1, vendor: 'fixture', validate: value => typeof value === 'number' ? { value } : { issues: [{ message: 'number required' }] } } };
const identity = (): ServerIdentity => ({ scope: { principalId: 'tester', projectId: 'local-host' }, agentIds: ['host.agent'], capabilities: ['runs:read', 'runs:submit', 'runs:cancel'], expiresAtMs: Date.now() + 60_000 });
const final = (): ModelResponse => ({ type: 'final', output: 4, usage: { costMicros: 0 } });

afterEach(async () => {
  for (const socket of sockets) socket.destroy(); sockets.clear();
  await Promise.all([...hosts].map(host => host.close())); hosts.clear(); vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function config(overrides: Partial<LocalServerOptions> = {}, generate: ModelAdapter['generate'] = async () => final()) {
  const model = vi.fn<ModelAdapter['generate']>(generate);
  const agent = defineAgent({ id: 'host.agent', version: '1', instructions: 'PRIVATE HOST SYSTEM PROMPT', input: numberSchema, output: numberSchema, tools: [],
    model: { id: 'host.model', capabilities: { tools: false, structuredOutput: true }, maxCostMicros: 0, generate: model },
  });
  const options: LocalServerOptions = { agents: [{ agent, permissions: { allow: ['model:host.model'] } }],
    authenticate: async ({ token }) => token === 'fixture-token' ? identity() : null, shutdownGraceMs: 20, ...overrides,
  };
  return { options, model };
}
async function fixture(overrides: Partial<LocalServerOptions> = {}, generate?: ModelAdapter['generate']) {
  const { options, model } = config(overrides, generate);
  const host = await listenAgentServer(options); hosts.add(host);
  return { host, model, client: createClient({ baseUrl: host.origin, token: () => 'fixture-token', requestTimeoutMs: 2_000 }) };
}
async function connection(origin: string, allowHalfOpen = false): Promise<Socket> {
  const url = new URL(origin); const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port), allowHalfOpen });
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  await once(socket, 'connect'); return socket;
}
/** Raw HTTP fixture keeps malformed headers out of Fetch's normalization layer. */
async function exchange(origin: string, wire: string): Promise<string> {
  const socket = await connection(origin); const chunks: Buffer[] = [];
  return await new Promise<string>((resolve, reject) => {
    socket.setTimeout(1_500, () => { socket.destroy(); reject(new Error('Local fixture socket did not close.')); });
    socket.on('data', data => chunks.push(data));
    socket.once('error', reject); socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.write(wire);
  });
}
function request(origin: string, path = '/v1/agents', headers: readonly string[] = [], method = 'GET') {
  return `${method} ${path} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nAuthorization: Bearer fixture-token\r\nConnection: close\r\n${headers.length ? `${headers.join('\r\n')}\r\n` : ''}\r\n`;
}
function code(wire: string) { return Number(/^HTTP\/1\.1 (\d+)/.exec(wire)?.[1]); }
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }

describe('real loopback Node host protocol', () => {
  it('serves authenticated SDK discovery, submission, ordered SSE and validated results over real sockets', async () => {
    const globals = { Request: globalThis.Request, Response: globalThis.Response, fetch: globalThis.fetch };
    const { host, client, model } = await fixture();
    expect(new URL(host.origin).hostname).toBe('127.0.0.1'); expect(Number(new URL(host.origin).port)).toBeGreaterThan(0);
    expect(await client.agents()).toEqual([{ id: 'host.agent', version: '1' }]);
    const run = await client.submit('host.agent', 2, { idempotencyKey: 'actual-http' }); const events = await collect(run.events());
    expect(events[0]?.type).toBe('run.started'); expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(await run.result(numberSchema)).toEqual({ status: 'succeeded', output: 4, evidence: [] }); expect(model).toHaveBeenCalledOnce();
    expect(globalThis.Request).toBe(globals.Request); expect(globalThis.Response).toBe(globals.Response); expect(globalThis.fetch).toBe(globals.fetch);
    await host.close(); expect(globalThis.Request).toBe(globals.Request); expect(globalThis.Response).toBe(globals.Response);
  });

  it('rejects missing and incorrect credentials without dispatching a model', async () => {
    const { host, model } = await fixture();
    for (const headers of [{}, { Authorization: 'Bearer incorrect' }]) {
      const response = await fetch(`${host.origin}/v1/agents`, { headers });
      expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: { code: 'UNAUTHORIZED' } });
    }
    expect(model).not.toHaveBeenCalled();
  });

  it('rejects foreign or malformed Host values and does not trust forwarding headers', async () => {
    const { host, model } = await fixture();
    for (const hostname of ['attacker.test', '127.0.0.1:not-a-port', 'bad host']) {
      const wire = request(host.origin).replace(`Host: ${new URL(host.origin).host}`, `Host: ${hostname}`);
      const reply = await exchange(host.origin, wire);
      // Invalid URL construction may be rejected by the adapter's safe error handler before routing.
      expect(hostname === 'attacker.test' ? [400] : [400, 503]).toContain(code(reply)); expect(reply).not.toContain('PRIVATE');
    }
    const forwarded = await exchange(host.origin, request(host.origin, '/v1/agents', ['X-Forwarded-Host: attacker.test', 'X-Forwarded-Proto: https', 'Forwarded: host=attacker.test;proto=https']));
    expect(code(forwarded)).toBe(200); expect(model).not.toHaveBeenCalled();
  });

  it('rejects a foreign absolute-form request target even when Host is locally correct', async () => {
    const { host } = await fixture();
    const reply = await exchange(host.origin, request(host.origin, 'http://attacker.test/v1/agents'));
    expect(code(reply)).toBe(400);
  });

  it('enforces exact browser origins, rejects credential query strings and serves bounded CORS preflight', async () => {
    const { host, model } = await fixture({ allowedOrigins: ['http://localhost:4321'] });
    const denied = await fetch(`${host.origin}/v1/agents`, { headers: { Authorization: 'Bearer fixture-token', Origin: 'https://attacker.test' } });
    expect(denied.status).toBe(403); await denied.body?.cancel();
    const query = await fetch(`${host.origin}/v1/agents?token=fixture-token`, { headers: { Authorization: 'Bearer fixture-token' } });
    expect(query.status).toBe(400); expect(await query.text()).not.toContain('fixture-token');
    const allowed = await fetch(`${host.origin}/v1/agents`, { headers: { Authorization: 'Bearer fixture-token', Origin: 'http://localhost:4321' } });
    expect(allowed.status).toBe(200); expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:4321');
    expect(allowed.headers.has('access-control-allow-credentials')).toBe(false); await allowed.body?.cancel();
    const preflight = await fetch(`${host.origin}/v1/agents`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:4321', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:4321'); expect(model).not.toHaveBeenCalled();
  });

  it('enforces declared and chunked body bounds before model dispatch', async () => {
    const { host, model } = await fixture({ limits: { maxBodyBytes: 64 } });
    const response = await fetch(`${host.origin}/v1/runs`, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'too-large' }, body: JSON.stringify({ agentId: 'host.agent', input: 'x'.repeat(100) }) });
    expect(response.status).toBe(413); await response.body?.cancel();
    const payload = JSON.stringify({ agentId: 'host.agent', input: 'x'.repeat(100) });
    const wire = request(host.origin, '/v1/runs', ['Content-Type: application/json', 'Idempotency-Key: chunked', 'Transfer-Encoding: chunked'], 'POST') + `${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n0\r\n\r\n`;
    expect(code(await exchange(host.origin, wire))).toBe(413); expect(model).not.toHaveBeenCalled();
  });

  it('rejects oversized headers, upgrades and CONNECT tunnels without model dispatch', async () => {
    const { host, model } = await fixture();
    expect(code(await exchange(host.origin, request(host.origin, '/v1/agents', [`X-Oversized: ${'x'.repeat(20_000)}`])))).toBe(431);
    const upgrade = request(host.origin, '/v1/agents', ['Upgrade: websocket']).replace('Connection: close', 'Connection: Upgrade');
    expect(code(await exchange(host.origin, upgrade))).toBe(426);
    expect(await exchange(host.origin, request(host.origin, new URL(host.origin).host, [], 'CONNECT'))).toBe(''); expect(model).not.toHaveBeenCalled();
  });

  it('does not leak authentication callback errors over the real socket', async () => {
    const { host } = await fixture({ authenticate: async () => { throw new Error('PRIVATE CREDENTIAL DATABASE FAILURE'); } });
    const response = await fetch(`${host.origin}/v1/agents`, { headers: { Authorization: 'Bearer fixture-token' } });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE');
  });
});

describe('loopback host admission and lifecycle', () => {
  it.each(['0.0.0.0', '::', '192.168.1.1', 'localhost', 'example.test'])('rejects non-literal-loopback bind %s before opening a socket', async hostname => {
    const listen = vi.spyOn(NetServer.prototype, 'listen');
    const { options } = config({ hostname: hostname as NonNullable<LocalServerOptions['hostname']> });
    await expect(listenAgentServer(options)).rejects.toThrow('loopback'); expect(listen).not.toHaveBeenCalled();
  });

  it('validates required authentication and registry configuration before opening a socket', async () => {
    const listen = vi.spyOn(NetServer.prototype, 'listen');
    const { options } = config();
    await expect(listenAgentServer({ ...options, authenticate: undefined as unknown as LocalServerOptions['authenticate'] })).rejects.toThrow();
    await expect(listenAgentServer({ ...options, limits: { maxRuns: 0 } })).rejects.toThrow();
    expect(listen).not.toHaveBeenCalled();
  });

  it('reports bind conflicts safely without interrupting the existing host', async () => {
    const first = await fixture(); const { options } = config({ port: Number(new URL(first.host.origin).port) });
    await expect(listenAgentServer(options)).rejects.toThrow('The local agent server could not start.');
    expect(await first.client.agents()).toHaveLength(1);
  });

  it('bounds shutdown with a non-cooperative authentication callback and prevents late dispatch', async () => {
    const began = deferred<void>(); const verifier = deferred<ServerIdentity | null>();
    const { host, client, model } = await fixture({ shutdownGraceMs: 20, authenticate: async () => { began.resolve(); return verifier.promise; } });
    const pending = client.submit('host.agent', 2, { idempotencyKey: 'shutdown-auth' }).catch(error => error as unknown);
    await began.promise; const start = Date.now(); await host.close(); expect(Date.now() - start).toBeLessThan(1_000);
    expect(await pending).toMatchObject({ code: 'TRANSPORT_FAILED' }); verifier.resolve(identity());
    await new Promise(resolve => setTimeout(resolve, 20)); expect(model).not.toHaveBeenCalled();
    await expect(fetch(`${host.origin}/v1/agents`)).rejects.toThrow();
  });

  it('closes partial-header sockets within the grace period and can reuse its released port', async () => {
    const { host } = await fixture(); const socket = await connection(host.origin);
    socket.write(`GET /v1/agents HTTP/1.1\r\nHost: ${new URL(host.origin).host}\r\nX-Unfinished: `);
    const closed = once(socket, 'close'); const firstClose = host.close(); const secondClose = host.close(); expect(firstClose).toBe(secondClose);
    await firstClose; await closed; expect(socket.destroyed).toBe(true);
    const replacement = await fixture({ port: Number(new URL(host.origin).port) }); expect(replacement.host.origin).toBe(host.origin);
    expect(await replacement.client.agents()).toHaveLength(1);
  });

  it('bounds shutdown when a rejected upgrade peer deliberately keeps its write half open', async () => {
    const { host } = await fixture(); const socket = await connection(host.origin, true);
    socket.resume(); const ended = once(socket, 'end');
    socket.write(request(host.origin, '/v1/agents', ['Upgrade: websocket']).replace('Connection: close', 'Connection: Upgrade'));
    await ended;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([host.close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Rejected upgrade kept host shutdown pending.')), 500); })]);
    } finally { clearTimeout(timer); socket.destroy(); }
  });

  it('supports an explicitly selected IPv6 loopback address without accepting forwarded authority', async () => {
    const { host, client } = await fixture({ hostname: '::1' });
    expect(new URL(host.origin).hostname).toBe('[::1]'); expect(await client.agents()).toHaveLength(1);
  });

  it('closes an active SSE observation and cancels a non-cooperative model without hanging shutdown', async () => {
    const began = deferred<void>(); const modelReply = deferred<ModelResponse>();
    const { host, client } = await fixture({}, async () => { began.resolve(); return modelReply.promise; });
    const run = await client.submit('host.agent', 2, { idempotencyKey: 'shutdown-stream' }); await began.promise;
    const stream = await fetch(`${host.origin}/v1/runs/${run.id}/events`, { headers: { Authorization: 'Bearer fixture-token' } });
    const reader = stream.body!.getReader(); expect((await reader.read()).done).toBe(false);
    const start = Date.now(); await host.close(); expect(Date.now() - start).toBeLessThan(1_000);
    while (!(await reader.read()).done) { /* Drain the finite metadata buffered before close. */ }
    reader.releaseLock(); modelReply.resolve(final());
  });
});
