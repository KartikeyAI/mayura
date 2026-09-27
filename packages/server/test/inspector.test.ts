import { afterEach, describe, expect, it } from 'vitest';
import type { Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer, type AgentServerOptions } from '../src/index.js';
import { INSPECTOR_ASSETS, INSPECTOR_BUNDLE_DIGEST } from '../src/inspector-bundle.js';

const publicOrigin = 'https://agents.example.test';
const any: Schema<unknown> = { '~standard': { version: 1, vendor: 'inspector-test', validate: value => ({ value }) } };
const agent = defineAgent({ id: 'echo', version: '1', instructions: 'PRIVATE_INSTRUCTIONS', tools: [], input: any, output: any,
  model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'final', output: 1, usage: { costMicros: 0 } }) } });
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(value => value.close())); });
function server(options: Partial<AgentServerOptions> = {}): AgentServer {
  const value = createAgentServer({ publicOrigin, agents: [{ agent, permissions: { allow: ['model:fixture'] } }],
    authenticate: async ({ token }) => token === 'TOKEN_OK' ? { scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'],
      capabilities: ['runs:read', 'runs:submit', 'operations:read'], expiresAtMs: Date.now() + 60_000 } : null, ...options });
  servers.push(value); return value;
}
const call = (value: AgentServer, path: string, init: RequestInit = {}) => value.fetch(new Request(new URL(path, publicOrigin), init));

describe('operator console assets', () => {
  it('embeds a React bundle with no inline script, no browser storage and no remote asset origins', () => {
    expect(INSPECTOR_BUNDLE_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(INSPECTOR_ASSETS).sort()).toEqual(['/inspector', '/inspector/app.css', '/inspector/app.js']);
    const html = INSPECTOR_ASSETS['/inspector']!.body;
    expect(html).toContain('src="/inspector/app.js"'); expect(html).toContain('href="/inspector/app.css"');
    expect(html.replace(/<script[^>]*\bsrc="[^"]*"[^>]*><\/script>/g, '')).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    const script = INSPECTOR_ASSETS['/inspector/app.js']!.body;
    expect(/localStorage|sessionStorage|document\.cookie/.test(script)).toBe(false);
    expect(/\beval\(|new Function\(/.test(script)).toBe(false);
  });

  it('is opt-in and serves only static assets under a strict CSP', async () => {
    expect((await call(server(), '/inspector')).status).not.toBe(200);
    const value = server({ inspector: true });
    for (const [path, type] of [['/inspector', 'text/html'], ['/inspector/', 'text/html'], ['/inspector/app.js', 'text/javascript'], ['/inspector/app.css', 'text/css']] as const) {
      const response = await call(value, path, { headers: { origin: publicOrigin } });
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain(type);
      const csp = response.headers.get('content-security-policy')!;
      for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) expect(csp).toContain(directive);
      expect(csp).not.toContain('unsafe-eval');
      expect(response.headers.get('x-frame-options')).toBe('DENY'); expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await response.text()).includes('PRIVATE_INSTRUCTIONS')).toBe(false);
    }
    expect((await call(value, '/inspector/app.js', { headers: { origin: 'https://evil.example' } })).status).toBe(200);
    expect((await call(value, '/inspector', { method: 'POST' })).status).not.toBe(200);
    expect((await call(value, '/inspector?token=x')).status).not.toBe(200);
    expect((await call(value, '/inspector/other.js')).status).not.toBe(200);
  });

  it('admits dialog styles only through a fresh per-page nonce, never unsafe-inline', async () => {
    const value = server({ inspector: true });
    const page = async () => { const response = await call(value, '/inspector'); return { csp: response.headers.get('content-security-policy')!, html: await response.text() }; };
    const first = await page(); const second = await page();
    const nonce = (csp: string) => /style-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'/.exec(csp)?.[1];
    expect(nonce(first.csp)).toBeDefined(); expect(nonce(first.csp)).not.toBe(nonce(second.csp));
    expect(first.html).toContain(`name="mayura-style-nonce" content="${nonce(first.csp)}"`); expect(first.html).not.toContain('__MAYURA_STYLE_NONCE__');
    for (const { csp } of [first, second]) expect(csp).not.toContain('unsafe-inline');
    const asset = (await call(value, '/inspector/app.js')).headers.get('content-security-policy')!;
    expect(asset).toContain("style-src 'self';"); expect(asset).not.toContain('nonce-');
  });

  it('accepts same-origin console commands but still denies foreign origins', async () => {
    const value = server({ inspector: true });
    const submit = (origin: string, key: string) => call(value, '/v1/runs', { method: 'POST', headers: { origin, authorization: 'Bearer TOKEN_OK',
      'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ agentId: 'echo', input: 1 }) });
    expect((await submit(publicOrigin, 'same-origin')).status).toBe(202);
    expect((await submit('https://evil.example', 'foreign')).status).toBe(403);
    const plain = server();
    expect((await call(plain, '/v1/agents', { headers: { origin: publicOrigin, authorization: 'Bearer TOKEN_OK' } })).status).toBe(403);
  });
});
