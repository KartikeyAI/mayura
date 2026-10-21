import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@mayura/client';
import { createAgentServer } from '../../server/src/index.js';
import { createSqliteStore } from '@mayura/storage-sqlite';

const { createChatServerOptions, demoScope, agentId } = await import(new URL('../../../examples/thread-chat/agent.mjs', import.meta.url).href);
const { createChatSession } = await import(new URL('../../../examples/thread-chat/session.js', import.meta.url).href);
const { ChatApp } = await import(new URL('../../../examples/thread-chat/app.js', import.meta.url).href);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dom: JSDOM; let root: Root; let target: HTMLDivElement; let directory: string; let store: ReturnType<typeof createSqliteStore>;
let api: ReturnType<typeof createAgentServer>; const sessions: any[] = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'); const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
beforeEach(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'https://chat.test' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window }); Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  target = dom.window.document.querySelector('#root')!; root = createRoot(target);
  directory = await mkdtemp(join(tmpdir(), 'mayura-chat-ui-')); store = createSqliteStore({ filename: join(directory, 'chat.sqlite') });
  await store.initialize(); await store.threads.initialize();
  api = createAgentServer({ ...createChatServerOptions(store, async () => ({ scope: demoScope, agentIds: [agentId],
    capabilities: ['runs:read', 'runs:submit', 'runs:approve', 'runs:cancel', 'threads:read', 'threads:write'], expiresAtMs: Date.now() + 60_000 })), publicOrigin: 'https://chat.test' });
});
afterEach(async () => {
  await act(async () => { root.unmount(); for (const session of sessions.splice(0)) session.dispose(); });
  await api.close(); await store.close(); await rm(directory, { recursive: true, force: true }); dom.window.close();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
});
const client = (transport?: typeof fetch) => createClient({ baseUrl: 'https://chat.test', token: () => 'test', fetch: transport ?? ((url, init) => api.fetch(new Request(url, init))) });
function session(connection = client()) { const result = createChatSession({ client: connection, storage: dom.window.localStorage }); sessions.push(result); return result; }
async function until(test: () => boolean) { const deadline = Date.now() + (process.env['CI'] === 'true' && process.platform === 'win32' ? 30_000 : 5_000); while (!test()) { if (Date.now() >= deadline) throw new Error('Expected chat state was not reached'); await act(async () => { await new Promise(done => setTimeout(done, 10)); }); } }
const button = (name: string) => [...target.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === name || node.textContent === name)!;
async function click(name: string) { await act(async () => { button(name).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); }

describe('runnable thread chat example', () => {
  it('wires the real history and approval components through reload, approval, rejection and cancellation', async () => {
    let chat = session(); await act(async () => { root.render(createElement(ChatApp, { session: chat })); await chat.open(); });
    await act(async () => { target.querySelector('form')!.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })); });
    await until(() => Boolean(chat.getSnapshot().approval)); const firstRunId = chat.getSnapshot().runId;
    await act(async () => { root.render(null); chat.dispose(); }); chat = session();
    await act(async () => { root.render(createElement(ChatApp, { session: chat })); await chat.open(); });
    await until(() => Boolean(chat.getSnapshot().approval)); expect(chat.getSnapshot().runId).toBe(firstRunId);
    await click('Approve for this note'); await until(() => chat.getSnapshot().phase === 'ready');
    expect(target.textContent).toContain('Saved your note after approval.'); expect(target.textContent).toContain('approved by local-user');
    await act(async () => { await chat.send('Do not save this one'); }); await until(() => Boolean(chat.getSnapshot().approval));
    const rejected = chat.getSnapshot().approval.getSnapshot().approval; const rejectedRunId = chat.getSnapshot().runId;
    await click('Reject for this note'); await until(() => chat.getSnapshot().phase === 'ready');
    expect(target.textContent).toContain('Your note was not saved.');
    expect(await store.read(JSON.stringify([demoScope.principalId, demoScope.projectId, 'notes']), `${rejectedRunId}:${rejected.callId}`)).toBeUndefined();
    await act(async () => { await chat.send('Cancel this turn'); }); await until(() => Boolean(chat.getSnapshot().approval));
    await click('Cancel current run'); await until(() => chat.getSnapshot().phase === 'ready');
    expect(chat.getSnapshot().runStore.getSnapshot().snapshot.status).toBe('cancelled'); expect(target.textContent).toContain('cancelled');
    const entries = await client().threadEntries(chat.getSnapshot().threadId);
    expect(entries.filter(entry => entry.kind === 'run' && entry.status !== 'running')).toHaveLength(3);
  });

  it('recovers an uncertain send after reload using the same idempotency key and never retries a decision', async () => {
    let lost = false; const keys: (string | null)[] = [];
    const connection = client(async (url, init) => {
      const request = new Request(url, init); const response = await api.fetch(request);
      if (request.method === 'POST' && new URL(request.url).pathname === '/v1/runs') {
        keys.push(request.headers.get('idempotency-key')); if (!lost) { lost = true; throw new Error('Simulated lost reply after acceptance'); }
      } return response;
    });
    let chat = session(connection); await chat.open(); await expect(chat.send('Retry this exact note')).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(chat.getSnapshot().hasPending).toBe(true); expect(keys).toHaveLength(1); chat.dispose();
    chat = session(connection); await chat.open(); expect(keys).toHaveLength(1); expect(chat.getSnapshot().hasPending).toBe(true);
    await chat.retrySubmission(); await until(() => Boolean(chat.getSnapshot().approval)); expect(keys).toEqual([keys[0], keys[0]]);
    await chat.getSnapshot().approval.submit('approved'); await until(() => chat.getSnapshot().phase === 'ready');
    const entries = await connection.threadEntries(chat.getSnapshot().threadId);
    expect(entries.filter(entry => entry.kind === 'user')).toHaveLength(1);
    expect(entries.filter(entry => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
  });

  it('detaches a missing saved conversation explicitly without deleting server data', async () => {
    dom.window.localStorage.setItem('mayura.thread-chat.v1', JSON.stringify({ threadId: 'missing', runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', message: 'Old local note' }));
    const chat = session(); await expect(chat.open()).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
    await act(async () => { root.render(createElement(ChatApp, { session: chat })); });
    await click('Forget missing chat'); await until(() => chat.getSnapshot().phase === 'ready');
    expect(chat.getSnapshot().threadId).not.toBe('missing'); expect(chat.getSnapshot().runId).toBeNull(); expect(chat.getSnapshot().message).toBeNull();
    expect(target.textContent).not.toContain('Old local note');
  });

});
