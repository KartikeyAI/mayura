import { describe, expect, it } from 'vitest';
import { CdpError, connectCdp, resolveCdpUrl, type CdpSocket } from '../src/cdp.js';

/** A WebSocket stand-in: records what is sent, and lets the test answer as the browser. */
function fakeSocket(options: { readonly refuse?: boolean; readonly never?: boolean } = {}) {
  const listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  const sent: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  let closed = false; let opened: { url: string; headers: Readonly<Record<string, string>> } | undefined;
  const emit = (type: string, event: { data: unknown } = { data: undefined }) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  const socket: CdpSocket = {
    // As a real WebSocket does, a closed one drops what it is given.
    send: data => { if (!closed) sent.push(JSON.parse(data)); },
    close: () => { if (!closed) { closed = true; queueMicrotask(() => emit('close')); } },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  return {
    sent, get closed() { return closed; }, get opened() { return opened; },
    factory: (url: string, headers: Readonly<Record<string, string>>) => {
      opened = { url, headers };
      // A real socket opens on a later task, after its listeners are added.
      if (!options.never) setTimeout(() => emit(options.refuse ? 'error' : 'open'), 0);
      return socket;
    },
    reply: (message: unknown) => emit('message', { data: typeof message === 'string' ? message : JSON.stringify(message) }),
    raw: (data: unknown) => emit('message', { data }),
    drop: () => { closed = true; emit('close'); },
  };
}

describe('connectCdp', () => {
  it('sends commands with ids and sessions, and settles each with its own reply', async () => {
    const fake = fakeSocket();
    const cdp = await connectCdp('ws://127.0.0.1:9222/devtools/browser/x', { webSocket: fake.factory, headers: { authorization: 'Bearer t' } });
    expect(fake.opened).toEqual({ url: 'ws://127.0.0.1:9222/devtools/browser/x', headers: { authorization: 'Bearer t' } });
    const first = cdp.send('Target.getTargets');
    const second = cdp.send('Page.navigate', { url: 'https://example.com/' }, { sessionId: 'S1' });
    expect(fake.sent).toEqual([{ id: 1, method: 'Target.getTargets', params: {} }, { id: 2, method: 'Page.navigate', params: { url: 'https://example.com/' }, sessionId: 'S1' }]);
    fake.reply({ id: 2, result: { frameId: 'F' } });
    fake.reply({ id: 1, result: { targetInfos: [] } });
    expect(await second).toEqual({ frameId: 'F' });
    expect(await first).toEqual({ targetInfos: [] });
  });

  it('turns a refusal into an error that names the command but not what the browser wrote', async () => {
    const fake = fakeSocket(); const cdp = await connectCdp('ws://x/', { webSocket: fake.factory });
    const call = cdp.send('Runtime.evaluate', { expression: '1' });
    fake.reply({ id: 1, error: { code: -32000, message: 'secret page content' } });
    const error = await call.catch(caught => caught);
    expect(error).toBeInstanceOf(CdpError);
    expect(error).toMatchObject({ code: 'TOOL_FAILED', method: 'Runtime.evaluate', cdpCode: -32000 });
    expect(error.message).not.toContain('secret');
  });

  it('delivers events to their handlers, filtered by session, until stopped', async () => {
    const fake = fakeSocket(); const cdp = await connectCdp('ws://x/', { webSocket: fake.factory });
    const all: unknown[] = []; const one: unknown[] = [];
    const stop = cdp.on('Page.loadEventFired', (params, sessionId) => all.push([params, sessionId]));
    cdp.on('Page.loadEventFired', params => one.push(params), 'S2');
    cdp.on('Page.loadEventFired', () => { throw new Error('a handler that fails'); });
    fake.reply({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S1' });
    fake.reply({ method: 'Page.loadEventFired', params: { timestamp: 2 }, sessionId: 'S2' });
    stop();
    fake.reply({ method: 'Page.loadEventFired', params: { timestamp: 3 } });
    expect(all).toEqual([[{ timestamp: 1 }, 'S1'], [{ timestamp: 2 }, 'S2']]);
    expect(one).toEqual([{ timestamp: 2 }]);
  });

  it('times out and cancels single commands without closing the connection', async () => {
    const fake = fakeSocket(); const cdp = await connectCdp('ws://x/', { webSocket: fake.factory });
    expect(await cdp.send('Page.reload', {}, { timeoutMs: 20 }).catch(caught => caught)).toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController();
    const call = cdp.send('Page.reload', {}, { signal: controller.signal }); controller.abort();
    expect(await call.catch(caught => caught)).toMatchObject({ code: 'CANCELLED' });
    expect(await cdp.send('Page.reload', {}, { signal: AbortSignal.abort() }).catch(caught => caught)).toMatchObject({ code: 'CANCELLED' });
    // A late reply to a command given up on is ignored.
    fake.reply({ id: 1, result: {} });
    expect(cdp.isClosed).toBe(false);
  });

  it('fails every pending command when the connection drops, and refuses new ones', async () => {
    const fake = fakeSocket(); const cdp = await connectCdp('ws://x/', { webSocket: fake.factory });
    const pending = cdp.send('Page.reload');
    fake.drop();
    expect(await pending.catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    await cdp.closed;
    expect(cdp.isClosed).toBe(true);
    expect(await cdp.send('Page.reload').catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });

  it('closes on a message that is too large, not JSON or not text', async () => {
    for (const message of [JSON.stringify({ id: 1, result: { pad: 'x'.repeat(2_000) } }), '{not json', new Uint8Array(4)]) {
      const fake = fakeSocket(); const cdp = await connectCdp('ws://x/', { webSocket: fake.factory, maxMessageBytes: 1_000 });
      const pending = cdp.send('Page.reload');
      fake.raw(message);
      expect(await pending.catch(caught => caught)).toBeInstanceOf(Error);
      expect(cdp.isClosed).toBe(true); expect(fake.closed).toBe(true);
    }
  });

  it('gives up connecting when refused, at its timeout, or when cancelled', async () => {
    expect(await connectCdp('ws://x/', { webSocket: fakeSocket({ refuse: true }).factory }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    const silent = fakeSocket({ never: true });
    expect(await connectCdp('ws://x/', { webSocket: silent.factory, timeoutMs: 20 }).catch(caught => caught)).toMatchObject({ code: 'TIMEOUT' });
    expect(silent.closed).toBe(true);
    const controller = new AbortController(); const waiting = connectCdp('ws://x/', { webSocket: fakeSocket({ never: true }).factory, signal: controller.signal });
    controller.abort();
    expect(await waiting.catch(caught => caught)).toMatchObject({ code: 'CANCELLED' });
  });

  it('uses a socket handed over already open, which sends no open event', async () => {
    const fake = fakeSocket({ never: true });
    const open = (url: string, headers: Readonly<Record<string, string>>) => Object.assign(fake.factory(url, headers), { readyState: 1 });
    const cdp = await connectCdp('ws://x/', { webSocket: open, timeoutMs: 1_000 });
    const call = cdp.send('Page.reload'); fake.reply({ id: 1, result: {} });
    expect(await call).toEqual({});
  });
});

describe('resolveCdpUrl', () => {
  it('uses ws URLs as they are, and asks an http endpoint, keeping the host asked for', async () => {
    expect(await resolveCdpUrl('wss://browser.example/devtools/browser/1?token=t')).toBe('wss://browser.example/devtools/browser/1?token=t');
    const seen: string[] = [];
    const fetch = (async (url: string | URL) => { seen.push(String(url)); return Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }); }) as typeof globalThis.fetch;
    expect(await resolveCdpUrl('http://chrome.internal:9222', { fetch })).toBe('ws://chrome.internal:9222/devtools/browser/abc');
    expect(seen).toEqual(['http://chrome.internal:9222/json/version']);
  });

  it('refuses other schemes, and endpoints that do not describe a browser', async () => {
    await expect(resolveCdpUrl('ftp://x/')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const failing = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(resolveCdpUrl('http://x:1', { fetch: failing })).rejects.toMatchObject({ reason: 'unavailable' });
    const odd = (async () => Response.json({ webSocketDebuggerUrl: 'javascript:alert(1)' })) as unknown as typeof fetch;
    await expect(resolveCdpUrl('http://x:1', { fetch: odd })).rejects.toMatchObject({ reason: 'unavailable' });
  });
});
