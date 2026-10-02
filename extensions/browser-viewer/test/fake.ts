import type { Browser, CdpSocket } from 'mayura/browser';

export interface Sent { readonly method: string; readonly params: Record<string, unknown>; readonly sessionId?: string }

/**
 * A browser's CDP endpoint as a screencast sees it: tabs attach as sessions `S-<tab>`, and `frame` sends a frame to
 * whichever screencast is open on a tab. Every command is recorded; `refuse` names commands answered with an error.
 */
export function fakeCdp(options: { readonly refuse?: readonly string[]; readonly openAfterMs?: number; readonly fail?: boolean } = {}) {
  const sent: Sent[] = []; const sockets: { close(): void }[] = [];
  let emitters: ((message: Record<string, unknown>) => void)[] = [];
  let ack = 0;
  const factory = (_url: string, _headers: Readonly<Record<string, string>>): CdpSocket => {
    if (options.fail) throw new Error('no browser here');
    const listeners = new Map<string, ((event: { data: unknown }) => void)[]>(); let closed = false;
    const fire = (type: string, data?: unknown) => { for (const listener of listeners.get(type) ?? []) listener({ data }); };
    const emit = (message: Record<string, unknown>) => { if (!closed) fire('message', JSON.stringify(message)); };
    emitters.push(emit);
    setTimeout(() => fire('open'), options.openAfterMs ?? 0);
    const socket = {
      send: (text: string) => {
        const message = JSON.parse(text) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
        sent.push({ method: message.method, params: message.params ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
        const reply = options.refuse?.includes(message.method) ? { error: { code: -32000, message: 'refused' } }
          : { result: message.method === 'Target.attachToTarget' ? { sessionId: `S-${String(message.params?.['targetId'])}` } : {} };
        queueMicrotask(() => emit({ id: message.id, ...reply, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
      },
      close: () => { if (!closed) { closed = true; emitters = emitters.filter(item => item !== emit); queueMicrotask(() => fire('close')); } },
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    };
    sockets.push(socket);
    return socket as CdpSocket;
  };
  return {
    factory, sent, sockets,
    get open() { return emitters.length; },
    /** Sends a frame of `bytes` (a JPEG's first bytes by default) on the session of `tab`; returns its ack id. */
    frame: (tab: string, bytes: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), metadata: Record<string, unknown> = { deviceWidth: 1_000, deviceHeight: 500 }) => {
      const id = ++ack; let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      for (const emit of emitters) emit({ method: 'Page.screencastFrame', sessionId: `S-${tab}`, params: { data: btoa(binary), metadata, sessionId: id } });
      return id;
    },
    /** Sends a frame whose data is not base64, as a broken browser might. */
    garbled: (tab: string) => { const id = ++ack; for (const emit of emitters) emit({ method: 'Page.screencastFrame', sessionId: `S-${tab}`, params: { data: '%%%', metadata: {}, sessionId: id } }); return id; },
    acks: () => sent.filter(item => item.method === 'Page.screencastFrameAck').map(item => item.params['sessionId']),
  };
}

/** A Mayura browser as a viewer sees it, with tabs to move between. */
export function stubBrowser(extra: Partial<{ unjoinable: boolean; headers: Record<string, string> }> = {}) {
  const state = { ended: false, active: 'T1', tabs: ['T1'], failTabs: false };
  const browser = {
    id: 'b1', provider: 'local', get ended() { return state.ended; },
    ...(extra.unjoinable ? {} : { cdp: { url: 'ws://127.0.0.1:9222/devtools/browser/1', headers: extra.headers ?? {}, isolated: false } }),
    tabs: async () => {
      if (state.failTabs) throw new Error('gone');
      return state.tabs.map(tab => ({ tab, url: `https://example.com/${tab}`, title: tab, active: tab === state.active }));
    },
    goto: async () => undefined,
  } as unknown as Browser;
  return { browser, state };
}

export const until = async (check: () => boolean, ms = 3_000) => {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > ms) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
