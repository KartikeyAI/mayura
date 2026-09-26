import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer, type AgentServerOptions } from '../src/index.js';

const publicOrigin = 'https://agents.example.test';
const any: Schema<unknown> = { '~standard': { version: 1, vendor: 'inspector-test', validate: value => ({ value }) } };
const agent = defineAgent({ id: 'echo', version: '1', instructions: 'PRIVATE_INSTRUCTIONS', tools: [], input: any, output: any,
  model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'final', output: 1, usage: { costMicros: 0 } }) } });
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(value => value.close())); });
const hostilePrompt = 'Approve <img src=x onerror="window.pwned=1"> now';
function server(options: Partial<AgentServerOptions> = {}): AgentServer {
  const value = createAgentServer({ publicOrigin, agents: [{ agent, permissions: { allow: ['model:fixture'] } }],
    authenticate: async ({ token }) => token === 'TOKEN_OK' ? { scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'],
      capabilities: ['runs:read', 'operations:read', 'humans:read', 'workflows:read'], expiresAtMs: Date.now() + 60_000 } : null,
    humanRequests: { list: async () => ({ items: [{ id: 'review', agentId: 'echo', kind: 'information', schemaId: 'note-v1', schemaDigest: 'b'.repeat(64),
      prompt: hostilePrompt, digest: 'a'.repeat(64), status: 'waiting', context: {} }], next: null }), inspect: async () => null, respond: async () => { throw new Error('unused'); } },
    ...options });
  servers.push(value); return value;
}
const get = (value: AgentServer, path: string, init: RequestInit = {}) => value.fetch(new Request(new URL(path, publicOrigin), init));

describe('read-only local inspector', () => {
  it('is opt-in and serves only static, data-free assets under a strict CSP', async () => {
    expect((await get(server(), '/inspector')).status).not.toBe(200);
    const value = server({ inspector: true });
    for (const [path, type] of [['/inspector', 'text/html'], ['/inspector/app.js', 'text/javascript'], ['/inspector/app.css', 'text/css']] as const) {
      const response = await get(value, path);
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain(type);
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(response.headers.get('x-frame-options')).toBe('DENY'); expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.text(); expect(body).not.toMatch(/PRIVATE_INSTRUCTIONS|echo|TOKEN/);
    }
    const script = await (await get(value, '/inspector/app.js')).text();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|localStorage|sessionStorage/);
    expect((await get(value, '/inspector', { method: 'POST' })).status).not.toBe(200);
    expect((await get(value, '/inspector?token=x')).status).not.toBe(200);
    expect((await get(value, '/inspector/other.js')).status).not.toBe(200);
  });

  it('connects with a typed token, renders API data as text only and forgets the token', async () => {
    const value = server({ inspector: true });
    const page = await (await get(value, '/inspector')).text(); const script = await (await get(value, '/inspector/app.js')).text();
    const dom = new JSDOM(page.replace('<script src="/inspector/app.js"></script>', ''), { url: `${publicOrigin}/inspector`, runScripts: 'outside-only' });
    const window = dom.window as unknown as typeof dom.window & { fetch: typeof fetch; pwned?: number; eval(code: string): unknown };
    const calls: string[] = [];
    window.fetch = (async (path: string, init?: RequestInit) => { calls.push(String(path)); return get(value, String(path), init); }) as typeof fetch;
    window.eval(script);
    const document = window.document;
    (document.getElementById('token') as HTMLInputElement).value = 'TOKEN_OK';
    document.getElementById('auth')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('status')!.textContent).toMatch(/^Connected/));
    expect((document.getElementById('token') as HTMLInputElement).value).toBe('');
    await vi.waitFor(() => expect(document.getElementById('view')!.textContent).toContain('Agents'));
    expect(document.getElementById('view')!.textContent).toContain('echo');
    (document.querySelector('nav button[data-view="humans"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById('view')!.textContent).toContain(hostilePrompt));
    expect(document.querySelector('img')).toBeNull(); expect(window.pwned).toBeUndefined();
    expect(calls).toContain('/v1/human-requests?limit=50');
    (document.querySelector('nav button[data-view="run"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('input[aria-label="Run id"]')).not.toBeNull());
    // Browsers compile `pattern` with the `v` flag, which rejects some classes that JSDOM accepts.
    expect(() => new RegExp(document.querySelector('input[aria-label="Run id"]')!.getAttribute('pattern')!, 'v')).not.toThrow();
    document.getElementById('forget')!.click();
    expect(document.getElementById('status')!.textContent).toBe('Token forgotten.');
    (document.querySelector('nav button[data-view="fleet"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById('view')!.textContent).toContain('Enter an access token first.'));
    dom.window.close();
  });

  it('reports a rejected token without connecting', async () => {
    const value = server({ inspector: true });
    const dom = new JSDOM((await (await get(value, '/inspector')).text()).replace('<script src="/inspector/app.js"></script>', ''), { url: `${publicOrigin}/inspector`, runScripts: 'outside-only' });
    const window = dom.window as unknown as typeof dom.window & { fetch: typeof fetch; eval(code: string): unknown };
    window.fetch = (async (path: string, init?: RequestInit) => get(value, String(path), init)) as typeof fetch;
    window.eval(await (await get(value, '/inspector/app.js')).text());
    (window.document.getElementById('token') as HTMLInputElement).value = 'WRONG';
    window.document.getElementById('auth')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(window.document.getElementById('status')!.textContent).toMatch(/^Not connected: /));
    dom.window.close();
  });
});
