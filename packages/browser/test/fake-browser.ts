import type { CdpSocket } from '../src/cdp.js';
import type { BrowserBackend, BrowserProvider } from '../src/contracts.js';

export interface Sent { readonly method: string; readonly params: Record<string, unknown>; readonly sessionId?: string }

/**
 * A browser speaking CDP over a fake socket, enough for `createBrowsers`: one page at first, attached on request, pages
 * that load when navigated, and every command recorded. `answer` overrides a command's reply (return an `error` to
 * refuse it).
 */
export function fakeBrowser(options: { readonly answer?: (sent: Sent) => Record<string, unknown> | undefined; readonly releaseError?: unknown } = {}) {
  const sent: Sent[] = []; const pages = new Map<string, { url: string; title: string }>([['T1', { url: 'about:blank', title: '' }]]);
  let emit: (message: Record<string, unknown>) => void = () => undefined;
  let nextTarget = 2; let released = 0; let sockets = 0; let created = 0;
  const attach = (targetId: string, type = 'page', browserContextId?: string) => queueMicrotask(() => emit({ method: 'Target.attachedToTarget', params: {
    sessionId: `S-${targetId}`, targetInfo: { targetId, type, url: pages.get(targetId)?.url ?? '', ...(browserContextId ? { browserContextId } : {}) }, waitingForDebugger: true } }));
  const respond = (message: Sent): Record<string, unknown> => {
    const custom = options.answer?.(message); if (custom) return custom;
    const target = message.sessionId?.slice(2);
    switch (message.method) {
      case 'Target.getTargets': return { targetInfos: [...pages.keys()].map(targetId => ({ targetId, type: 'page', attached: false })) };
      case 'Target.attachToTarget': attach(String(message.params['targetId'])); return { sessionId: `S-${String(message.params['targetId'])}` };
      case 'Target.createTarget': { const targetId = `T${nextTarget++}`; pages.set(targetId, { url: 'about:blank', title: '' }); attach(targetId, 'page', message.params['browserContextId'] as string | undefined); return { targetId }; }
      case 'Target.createBrowserContext': return { browserContextId: 'C1' };
      case 'Target.getTargetInfo': { const page = pages.get(String(message.params['targetId'])); return { targetInfo: { targetId: message.params['targetId'], type: 'page', url: page?.url ?? '', title: page?.title ?? '' } }; }
      case 'Page.navigate': {
        const url = String(message.params['url']); const page = pages.get(target!)!;
        page.url = url; page.title = `Title of ${new URL(url).pathname}`;
        queueMicrotask(() => {
          emit({ method: 'Network.responseReceived', sessionId: message.sessionId, params: { type: 'Document', response: { status: 200 } } });
          emit({ method: 'Page.loadEventFired', sessionId: message.sessionId, params: {} });
        });
        return { frameId: 'F', loaderId: 'L' };
      }
      case 'Accessibility.getFullAXTree': return { nodes: [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'page' }, childIds: ['2'] },
        { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 7 },
      ] };
      case 'Page.captureScreenshot': return { data: 'iVBORw0KGgo=' };
      default: return {};
    }
  };
  const factory = (_url: string, _headers: Readonly<Record<string, string>>): CdpSocket => {
    sockets++;
    const listeners = new Map<string, ((event: { data: unknown }) => void)[]>(); let closed = false;
    const fire = (type: string, data?: unknown) => { for (const listener of listeners.get(type) ?? []) listener({ data }); };
    emit = message => { if (!closed) fire('message', JSON.stringify(message)); };
    setTimeout(() => fire('open'), 0);
    return {
      send: text => {
        const message = JSON.parse(text) as Sent & { id: number };
        const record: Sent = { method: message.method, params: message.params, ...(message.sessionId ? { sessionId: message.sessionId } : {}) };
        sent.push(record);
        const reply = respond(record);
        queueMicrotask(() => emit('error' in reply && reply['error'] ? { id: message.id, error: reply['error'] } : { id: message.id, result: reply }));
      },
      close: () => { if (!closed) { closed = true; queueMicrotask(() => fire('close')); } },
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    };
  };
  const provider = (extra: Partial<BrowserBackend> & { readonly liveView?: boolean } = {}): BrowserProvider => ({
    id: 'fake', maxLifetimeMs: 3_600_000, features: { liveView: extra.liveView ?? false },
    create: async () => (created++, {
      id: 'fake-1', cdp: { url: 'ws://fake.test/devtools/browser/1' }, ...extra,
      release: async () => { released++; if (options.releaseError) throw options.releaseError; },
    }),
  });
  return {
    sent, pages, factory, provider,
    /** Sends an event as the browser, such as a paused request. */
    event: (method: string, params: Record<string, unknown>, sessionId?: string) => emit({ method, params, ...(sessionId ? { sessionId } : {}) }),
    get released() { return released; }, get sockets() { return sockets; }, get created() { return created; },
  };
}
