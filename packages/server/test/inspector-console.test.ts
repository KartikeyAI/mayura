import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer, type ServerIdentity } from '../src/index.js';
import { INSPECTOR_ASSETS } from '../src/inspector-bundle.js';

const publicOrigin = 'https://console.example.test';
const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Run the built console in a DOM against a real server, the way a browser on the public origin would. */
async function console(identity: ServerIdentity) {
  const agent = defineAgent({ id: 'echo', version: '1', instructions: 'Fixture.', tools: [], input: schema, output: schema,
    model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'final', output: 1, usage: { costMicros: 0 } }) } });
  const server: AgentServer = createAgentServer({ publicOrigin, inspector: true, agents: [{ agent, permissions: { allow: ['model:fixture'] } }],
    authenticate: async ({ token }) => token === 'OPERATOR_TOKEN' ? identity : null,
    workflowIndex: { list: async () => ({ items: [], next: null }) }, workflowViews: { inspect: async () => null } });
  cleanups.push(() => server.close());
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `${publicOrigin}/inspector`, runScripts: 'outside-only', pretendToBeVisual: true });
  cleanups.push(() => dom.window.close());
  const paths: string[] = [];
  const window = dom.window as unknown as Record<string, unknown> & typeof dom.window;
  // The page's own origin is the only destination; the browser sends its Origin header as it would for a module page.
  window['fetch'] = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), publicOrigin); paths.push(url.pathname);
    const headers = new Headers(init.headers); headers.set('origin', publicOrigin);
    return server.fetch(new Request(url, { ...init, headers }));
  };
  window['matchMedia'] = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof dom.window.matchMedia;
  for (const name of ['TextEncoder', 'TextDecoder', 'MessageChannel', 'ReadableStream', 'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal'] as const)
    window[name] = globalThis[name];
  if (!window.crypto?.randomUUID) Object.defineProperty(window, 'crypto', { configurable: true, value: globalThis.crypto });
  window.eval(INSPECTOR_ASSETS['/inspector/app.js']!.body);
  const document = window.document;
  await vi.waitFor(() => expect(document.querySelector('#token')).not.toBeNull(), { timeout: 5_000, interval: 20 });
  const input = document.querySelector<HTMLInputElement>('#token')!;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'OPERATOR_TOKEN');
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { document, paths };
}
const navigation = (document: Document) => [...document.querySelectorAll('nav[aria-label="Sections"] button')].map(button => button.textContent?.trim());

describe('operator console access', () => {
  it('connects with a token that lacks runs:read and shows only the views it may use', async () => {
    const { document, paths } = await console({ scope: { principalId: 'ops', projectId: 'orders' }, agentIds: ['echo'], capabilities: ['workflows:read'],
      expiresAtMs: Date.now() + 60_000 });
    await vi.waitFor(() => expect(navigation(document)).toEqual(['Workflows']), { timeout: 5_000, interval: 20 });
    expect(paths).toContain('/v1/session'); expect(paths).not.toContain('/v1/agents');
    expect(document.body.textContent).toContain('ops · orders');
  });

  it('shows every view a broad token may use, and a clear message for a token that fits none', async () => {
    const broad = await console({ scope: { principalId: 'ops', projectId: 'orders' }, agentIds: ['echo'],
      capabilities: ['runs:read', 'runs:cancel', 'operations:read', 'workflows:read', 'workflows:control'], expiresAtMs: Date.now() + 60_000 });
    await vi.waitFor(() => expect(navigation(broad.document)).toEqual(['Overview', 'Workflows', 'Agent runs']), { timeout: 5_000, interval: 20 });
    await vi.waitFor(() => expect(broad.paths).toContain('/v1/agents'), { timeout: 5_000, interval: 20 });
    const none = await console({ scope: { principalId: 'ops', projectId: 'orders' }, agentIds: [], capabilities: ['humans:respond'], expiresAtMs: Date.now() + 60_000 });
    await vi.waitFor(() => expect(none.document.body.textContent).toContain('Nothing to show for this token'), { timeout: 5_000, interval: 20 });
  });
});
