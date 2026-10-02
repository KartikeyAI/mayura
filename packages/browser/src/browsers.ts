import { assertPositiveInteger, MayuraError } from '@mayura/core';
import { CdpError, connectCdp, type CdpConnection, type CdpSocketFactory } from './cdp.js';
import { BrowserError, type BrowserBackend, type BrowserFeatures, type BrowserProvider } from './contracts.js';
import { parseKeys } from './keys.js';
import { originPolicy, type OriginPolicy } from './origins.js';
import { outline, type AxNode } from './snapshot.js';

export interface BrowsersOptions {
  /** How many browsers may be open at once. */
  readonly maxBrowsers: number;
  /** The longest a browser may live, in milliseconds; at most the provider's. */
  readonly maxLifetimeMs: number;
  /**
   * The origins pages may load from, such as `['https://example.com', 'https://*.example.org']`, or `'all'`. Nothing is
   * allowed by default. Every request is checked — navigations, redirects, frames, scripts, images and fetches — and one
   * to another origin fails as blocked.
   */
  readonly origins: 'all' | readonly string[];
  /** How many tabs a browser may have open; 8 by default. */
  readonly maxTabs?: number;
  /** The longest one call (other than a navigation) may take; 30 s by default. */
  readonly callTimeoutMs?: number;
  /** The longest a navigation waits for its page to load; 30 s by default. A page still loading is returned as it is. */
  readonly navigationTimeoutMs?: number;
  /** The most bytes of a snapshot or of page text; 256 KiB by default. */
  readonly maxTextBytes?: number;
  /** The largest screenshot; 8 MiB by default. */
  readonly maxScreenshotBytes?: number;
  /** The window size pages are laid out for; 1280 × 800 by default. */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Labels every browser is tagged with. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Opens the CDP WebSocket, for runtimes whose WebSocket cannot send headers (see `CdpSocketFactory`). */
  readonly webSocket?: CdpSocketFactory;
}

export interface CallOptions { readonly signal?: AbortSignal }
export interface PageState {
  /** The tab's id, for `selectTab` and `closeTab`. */
  readonly tab: string;
  readonly url: string;
  readonly title: string;
}
export interface NavigationResult extends PageState {
  /** The HTTP status of the page's document, when there was one. */
  readonly status?: number;
  /** False when the page was still loading at the navigation timeout. */
  readonly loaded: boolean;
}
export interface Snapshot extends PageState {
  /** One line per meaningful element, indented by depth; `[ref=e12]` marks the ones the action methods take. */
  readonly text: string;
  readonly truncated: boolean;
  /** Dialogs the page opened since the last snapshot, each dismissed (accepted when the page was being left). */
  readonly dialogs: readonly string[];
}

/** A browser to drive: navigate, read pages as snapshots, and act on the elements they name. */
export interface Browser {
  readonly id: string;
  readonly provider: string;
  readonly features: BrowserFeatures;
  /** Where a person can watch, for providers with a live view. It may carry a token: treat it as a secret. */
  readonly liveViewUrl?: string;
  /** True once the browser was released, reached its lifetime, or its connection closed. */
  readonly ended: boolean;
  goto(url: string, options?: CallOptions): Promise<NavigationResult>;
  back(options?: CallOptions): Promise<NavigationResult>;
  forward(options?: CallOptions): Promise<NavigationResult>;
  reload(options?: CallOptions): Promise<NavigationResult>;
  /** The page as an outline; refs from earlier snapshots stop working. */
  snapshot(options?: CallOptions): Promise<Snapshot>;
  /** The visible text of the page, or of one element. */
  text(options?: CallOptions & { readonly ref?: string }): Promise<PageState & { readonly text: string; readonly truncated: boolean }>;
  click(ref: string, options?: CallOptions & { readonly double?: boolean }): Promise<PageState>;
  /** Replaces an input's text, as typing it would. */
  fill(ref: string, text: string, options?: CallOptions): Promise<PageState>;
  /** Presses a key such as `Enter`, `Tab` or `Control+a` on what has focus. */
  press(keys: string, options?: CallOptions): Promise<PageState>;
  /** Chooses an option of a `<select>` by its value or its label. */
  select(ref: string, option: string, options?: CallOptions): Promise<PageState>;
  hover(ref: string, options?: CallOptions): Promise<PageState>;
  /** Scrolls the page, or the element, by `dy` pixels (negative scrolls up). */
  scroll(dy: number, options?: CallOptions & { readonly ref?: string }): Promise<PageState>;
  screenshot(options?: CallOptions & { readonly fullPage?: boolean }): Promise<{ readonly data: Uint8Array; readonly mediaType: 'image/png' }>;
  /** Runs a JavaScript expression in the page and returns its value as JSON, or what it threw. */
  evaluate(expression: string, options?: CallOptions): Promise<{ readonly value?: unknown; readonly error?: string }>;
  tabs(options?: CallOptions): Promise<readonly (PageState & { readonly active: boolean })[]>;
  newTab(url?: string, options?: CallOptions): Promise<NavigationResult | PageState>;
  selectTab(tab: string, options?: CallOptions): Promise<PageState>;
  closeTab(tab: string, options?: CallOptions): Promise<void>;
  /** Ends the browser. Releasing again does nothing. */
  release(options?: CallOptions): Promise<void>;
}

export interface Browsers {
  readonly provider: string;
  readonly features: BrowserFeatures;
  /** How many browsers are open. */
  readonly size: number;
  open(options?: CallOptions & { readonly lifetimeMs?: number; readonly labels?: Readonly<Record<string, string>> }): Promise<Browser>;
  /** Releases every open browser, and opens no more. */
  close(): Promise<void>;
}

const providerId = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const labelKey = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const refPattern = /^e[1-9][0-9]{0,6}$/u;
const encoder = new TextEncoder(); const decoder = new TextDecoder('utf-8');
const cancelled = () => new MayuraError('CANCELLED', 'The browser call was cancelled.');
const staleRef = () => new MayuraError('INVALID_INPUT', 'That ref is not on the page as last snapshotted: take a snapshot and use its refs.');

function bound(value: number | undefined, name: string, fallback: number, max: number): number {
  const result = value ?? fallback; assertPositiveInteger(result, name);
  if (result > max) throw new MayuraError('INVALID_CONFIG', `${name} is at most ${max}.`);
  return result;
}
function labels(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('INVALID_INPUT', 'labels must be an object of strings.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16 || entries.some(([key, item]) => !labelKey.test(key) || typeof item !== 'string' || !/^[ -~]{0,256}$/u.test(item))) {
    throw new MayuraError('INVALID_INPUT', 'labels has at most 16 entries: keys are lowercase letters, digits, ., _ and -, and values printable ASCII.');
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}
function clip(value: string, max: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(value);
  return bytes.byteLength <= max ? { text: value, truncated: false } : { text: decoder.decode(bytes.subarray(0, max)).replace(/�$/u, ''), truncated: true };
}
function fromBase64(text: string): Uint8Array {
  const binary = atob(text); const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}

/** A page this browser drives: a tab, with its flattened CDP session. */
interface Tab { readonly targetId: string; readonly sessionId: string; readonly dialogs: string[] }

/**
 * Browsers from a provider, such as `localBrowsers()` from `mayura/browser/local` or a `@mayurajs/browser-*` package's,
 * within limits: how many at once, how long each lives, and which origins their pages may load from. Downloads are
 * refused, file pickers stay closed, and dialogs are dismissed and reported in the next snapshot.
 */
export function createBrowsers(provider: BrowserProvider, options: BrowsersOptions): Browsers {
  if (!provider || typeof provider.id !== 'string' || !providerId.test(provider.id) || typeof provider.create !== 'function') throw new MayuraError('INVALID_CONFIG', 'createBrowsers() needs a browser provider.');
  if (!provider.features || typeof provider.features.liveView !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'The browser provider must declare its features.');
  const id = provider.id; const features = Object.freeze({ liveView: provider.features.liveView });
  assertPositiveInteger(provider.maxLifetimeMs, 'provider maxLifetimeMs');
  if (!options) throw new MayuraError('INVALID_CONFIG', 'createBrowsers() needs options with maxBrowsers, maxLifetimeMs and origins.');
  const maxBrowsers = bound(options.maxBrowsers, 'maxBrowsers', 1, 1_000);
  const maxLifetimeMs = bound(options.maxLifetimeMs, 'maxLifetimeMs', 1, Math.min(provider.maxLifetimeMs, 2_147_483_647));
  const policy: OriginPolicy = originPolicy(options.origins);
  const maxTabs = bound(options.maxTabs, 'maxTabs', 8, 100);
  const callTimeoutMs = bound(options.callTimeoutMs, 'callTimeoutMs', 30_000, 600_000);
  const navigationTimeoutMs = bound(options.navigationTimeoutMs, 'navigationTimeoutMs', 30_000, 600_000);
  const maxTextBytes = bound(options.maxTextBytes, 'maxTextBytes', 262_144, 16 * 1_048_576);
  const maxScreenshotBytes = bound(options.maxScreenshotBytes, 'maxScreenshotBytes', 8 * 1_048_576, 64 * 1_048_576);
  const viewport = options.viewport ?? { width: 1_280, height: 800 };
  if (!viewport || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) || viewport.width < 100 || viewport.height < 100 || viewport.width > 7_680 || viewport.height > 4_320) {
    throw new MayuraError('INVALID_CONFIG', 'viewport is a width and height from 100 × 100 to 7,680 × 4,320.');
  }
  const baseLabels = labels(options.labels);
  if (options.webSocket !== undefined && typeof options.webSocket !== 'function') throw new MayuraError('INVALID_CONFIG', 'webSocket must be a function.');

  const alive = new Set<{ release(): Promise<void> }>();
  let pending = 0; let closed = false;

  /** Connects to a backend's browser and makes it safe to hand over: origins enforced on every target, downloads refused. */
  const drive = async (backend: BrowserBackend, lifetimeMs: number, signal: AbortSignal): Promise<Browser> => {
    if (!backend || typeof backend.id !== 'string' || !/^[ -~]{1,256}$/u.test(backend.id) || typeof backend.release !== 'function'
      || !backend.cdp || typeof backend.cdp.url !== 'string' || !/^wss?:\/\//u.test(backend.cdp.url)) throw new BrowserError('invalid_response');
    const cdp: CdpConnection = await connectCdp(backend.cdp.url, { ...(backend.cdp.headers ? { headers: backend.cdp.headers } : {}), ...(options.webSocket ? { webSocket: options.webSocket } : {}), signal, timeoutMs: callTimeoutMs });
    const tabs = new Map<string, Tab>(); // by targetId
    let context: string | undefined; // the browser context, when isolated
    let active: string | undefined; let refs = new Map<string, { readonly sessionId: string; readonly backendNodeId: number }>();
    const send = <T = Record<string, unknown>>(method: string, params: Record<string, unknown>, sessionId: string | undefined, callSignal: AbortSignal, timeoutMs = callTimeoutMs) =>
      cdp.send<T>(method, params, { ...(sessionId ? { sessionId } : {}), signal: callSignal, timeoutMs });
    const background = AbortSignal.timeout(lifetimeMs);

    // Requests: every one is checked against the origins, in every target, before it leaves.
    cdp.on('Fetch.requestPaused', (params, sessionId) => {
      const request = params['request'] as { url?: unknown } | undefined; const requestId = params['requestId'];
      if (typeof requestId !== 'string') return;
      const allowed = typeof request?.url === 'string' && policy.allows(request.url);
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, sessionId, background).catch(() => undefined);
    });
    cdp.on('Page.javascriptDialogOpening', (params, sessionId) => {
      const tab = [...tabs.values()].find(item => item.sessionId === sessionId);
      const message = typeof params['message'] === 'string' ? params['message'].slice(0, 500) : '';
      if (tab && tab.dialogs.length < 20) tab.dialogs.push(`${String(params['type'])}: ${message}`);
      void send('Page.handleJavaScriptDialog', { accept: params['type'] === 'beforeunload' }, sessionId, background).catch(() => undefined);
    });
    cdp.on('Target.detachedFromTarget', params => {
      for (const [targetId, tab] of tabs) if (tab.sessionId === params['sessionId']) { tabs.delete(targetId); if (active === targetId) active = tabs.keys().next().value; }
    });
    /** Prepares a target the moment it is attached, while it waits: nothing runs in it before the origins are enforced. */
    const prepare = async (sessionId: string, type: string, targetId: string, checked: (ok: boolean) => void) => {
      try {
        if (!policy.all) {
          try { await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId, background); }
          catch (error) {
            // A dedicated worker has no Fetch of its own: its requests are checked in its page. Any other target that
            // cannot be checked is never let run.
            if (!(type === 'worker' && error instanceof CdpError)) throw error;
          }
        }
        checked(true);
        if (type === 'page') {
          await Promise.all([
            send('Page.enable', {}, sessionId, background),
            send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId, background),
            send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId, background),
            send('Network.enable', {}, sessionId, background),
            send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId, background),
          ]);
          if (!tabs.has(targetId)) tabs.set(targetId, { targetId, sessionId, dialogs: [] });
          active ??= targetId;
        }
        await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId, background).catch(() => undefined);
        // Not awaited: the browser answers only once every session holding the target lets it run.
        void send('Runtime.runIfWaitingForDebugger', {}, sessionId, background).catch(() => undefined);
      } catch {
        // A target whose requests cannot be checked is not let run: it stays paused, and is closed where it can be.
        checked(false);
        await send('Target.closeTarget', { targetId }, undefined, background).catch(() => undefined);
      }
    };
    // Targets by id, settling true once their requests are checked (false when they cannot be).
    const attaching = new Set<Promise<void>>(); const attached = new Map<string, Promise<boolean>>();
    cdp.on('Target.attachedToTarget', params => {
      const info = params['targetInfo'] as { targetId?: unknown; type?: unknown; browserContextId?: unknown } | undefined;
      if (typeof params['sessionId'] !== 'string' || typeof info?.targetId !== 'string') return;
      if (backend.isolate && info.browserContextId !== context) {
        // Someone else's page: let it run, and let go of it.
        const other = params['sessionId'];
        void send('Runtime.runIfWaitingForDebugger', {}, other, background).catch(() => undefined)
          .finally(() => send('Target.detachFromTarget', { sessionId: other }, undefined, background).catch(() => undefined));
        return;
      }
      // Each target once: the browser's auto-attach and a page's own can both report it.
      const first = attached.get(info.targetId);
      if (first) {
        // Let go of the second session once the first has the target's requests checked; never when it cannot.
        const extra = params['sessionId'];
        void first.then(ok => { if (!ok) return;
          void send('Runtime.runIfWaitingForDebugger', {}, extra, background).catch(() => undefined);
          void send('Target.detachFromTarget', { sessionId: extra }, undefined, background).catch(() => undefined);
        });
        return;
      }
      let checked!: (ok: boolean) => void;
      attached.set(info.targetId, new Promise<boolean>(resolve => { checked = resolve; }));
      const work = prepare(params['sessionId'], String(info.type), info.targetId, checked);
      attaching.add(work); void work.finally(() => attaching.delete(work));
    });

    const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(callTimeoutMs)]);
    try {
      await send('Browser.setDownloadBehavior', { behavior: 'deny' }, undefined, setupSignal).catch(() => undefined);
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, undefined, setupSignal);
      if (backend.isolate) {
        context = (await send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true }, undefined, setupSignal)).browserContextId;
      }
      // The browser's auto-attach reports the pages already open; settle them first.
      await new Promise(resolve => setTimeout(resolve, 50)); await Promise.all(attaching);
      if (!backend.isolate && tabs.size === 0) {
        const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets', {}, undefined, setupSignal);
        for (const target of targetInfos.filter(item => item.type === 'page' && !attached.has(item.targetId))) {
          await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, undefined, setupSignal);
        }
        await Promise.all(attaching);
      }
      if (tabs.size === 0) { await send('Target.createTarget', { url: 'about:blank', ...(context ? { browserContextId: context } : {}) }, undefined, setupSignal); }
      for (let wait = 0; tabs.size === 0 && wait < 50; wait++) { await Promise.all(attaching); await new Promise(resolve => setTimeout(resolve, 20)); }
      if (tabs.size === 0) throw new BrowserError('invalid_response');
    } catch (error) { cdp.close(); throw error; }

    const expiresAt = Date.now() + lifetimeMs;
    let ended = false; let releasing: Promise<void> | undefined; let released = false;
    const release = (caller?: AbortSignal): Promise<void> => {
      if (released) return Promise.resolve();
      if (releasing) return releasing;
      ended = true; clearTimeout(expiry);
      // An isolated context goes when the connection does (disposeOnDetach); disposing it first closes its pages now.
      const disposed = context ? send('Target.disposeBrowserContext', { browserContextId: context }, undefined, AbortSignal.timeout(5_000)).catch(() => undefined) : Promise.resolve();
      void disposed.finally(() => cdp.close());
      const call = AbortSignal.any([AbortSignal.timeout(callTimeoutMs), ...(caller ? [caller] : [])]);
      releasing = (async () => {
        try { await backend.release({ signal: call }); }
        catch (error) {
          if (!(error instanceof BrowserError && error.reason === 'gone')) { releasing = undefined; throw caller?.aborted ? cancelled() : error instanceof MayuraError ? error : new BrowserError('unavailable'); }
        }
        released = true; alive.delete(entry);
      })();
      return releasing;
    };
    const entry = { release: () => release() };
    const expiry = setTimeout(() => { void release().catch(() => undefined); }, lifetimeMs);
    (expiry as { unref?: () => void }).unref?.();
    alive.add(entry);
    void cdp.closed.then(() => { ended = true; });

    // One call at a time: actions on a page depend on the one before.
    let queue: Promise<unknown> = Promise.resolve();
    const run = <T>(caller: AbortSignal | undefined, body: (signal: AbortSignal) => Promise<T>, timeoutMs = callTimeoutMs): Promise<T> => {
      if (caller !== undefined && !(caller instanceof AbortSignal)) return Promise.reject(new MayuraError('INVALID_INPUT', 'signal must be an AbortSignal.'));
      const result = queue.then(async () => {
        if (caller?.aborted) throw cancelled();
        if (ended || Date.now() >= expiresAt) throw new BrowserError('gone');
        const timeout = AbortSignal.timeout(timeoutMs);
        const callSignal = caller ? AbortSignal.any([caller, timeout]) : timeout;
        try { return await body(callSignal); }
        catch (error) {
          if (caller?.aborted) throw cancelled();
          if (timeout.aborted) throw new BrowserError('timeout');
          if (error instanceof MayuraError) throw error;
          throw new BrowserError('invalid_response');
        }
      });
      queue = result.catch(() => undefined);
      return result;
    };
    const current = (): Tab => { const tab = active === undefined ? undefined : tabs.get(active); if (!tab) throw new BrowserError('gone'); return tab; };
    const state = async (tab: Tab, callSignal: AbortSignal): Promise<PageState> => {
      const { targetInfo } = await send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId: tab.targetId }, undefined, callSignal);
      return { tab: tab.targetId, url: targetInfo.url, title: targetInfo.title.slice(0, 500) };
    };
    /** Waits for the tab's next load, up to the navigation timeout; whether it came. */
    const nextLoad = (tab: Tab, callSignal: AbortSignal) => {
      let stop: (() => void) | undefined; let status: number | undefined;
      const statusOff = cdp.on('Network.responseReceived', params => { if (params['type'] === 'Document' && status === undefined) status = (params['response'] as { status?: number } | undefined)?.status; }, tab.sessionId);
      const loaded = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), navigationTimeoutMs);
        const off = cdp.on('Page.loadEventFired', () => resolve(true), tab.sessionId);
        const onAbort = () => resolve(false);
        callSignal.addEventListener('abort', onAbort, { once: true });
        stop = () => { clearTimeout(timer); off(); statusOff(); callSignal.removeEventListener('abort', onAbort); };
      });
      return { wait: async () => { const done = await loaded; stop?.(); return { loaded: done, status }; }, cancel: () => stop?.() };
    };
    const navigated = async (tab: Tab, callSignal: AbortSignal, start: () => Promise<{ readonly sameDocument?: boolean; readonly errorText?: string } | void>): Promise<NavigationResult> => {
      const load = nextLoad(tab, callSignal);
      let begun;
      try { begun = await start(); } catch (error) { load.cancel(); throw error; }
      if (begun?.errorText) {
        load.cancel();
        if (/BLOCKED_BY_CLIENT/u.test(begun.errorText)) throw new MayuraError('PERMISSION_DENIED', 'That address is outside the origins this browser may load.');
        return { ...(await state(tab, callSignal)), loaded: false };
      }
      if (begun?.sameDocument) { load.cancel(); return { ...(await state(tab, callSignal)), loaded: true }; }
      const { loaded, status } = await load.wait();
      if (callSignal.aborted) throw cancelled();
      return { ...(await state(tab, callSignal)), loaded, ...(status === undefined ? {} : { status }) };
    };
    const checkUrl = (url: unknown): string => {
      if (typeof url !== 'string' || url.length > 8_192) throw new MayuraError('INVALID_INPUT', 'url must be an http(s) URL.');
      let parsed: URL; try { parsed = new URL(url); } catch { throw new MayuraError('INVALID_INPUT', 'url must be an http(s) URL.'); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && url !== 'about:blank') throw new MayuraError('INVALID_INPUT', 'url must be an http(s) URL.');
      if (!policy.allows(parsed.href)) throw new MayuraError('PERMISSION_DENIED', `${parsed.origin} is outside the origins this browser may load.`);
      return parsed.href;
    };
    const node = (ref: unknown): { sessionId: string; backendNodeId: number } => {
      if (typeof ref !== 'string' || !refPattern.test(ref)) throw new MayuraError('INVALID_INPUT', 'A ref is e followed by a number, from a snapshot.');
      const found = refs.get(ref);
      if (!found || found.sessionId !== current().sessionId) throw staleRef();
      return found;
    };
    const resolve = async (target: { sessionId: string; backendNodeId: number }, callSignal: AbortSignal) => {
      try { return (await send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: target.backendNodeId }, target.sessionId, callSignal)).object.objectId; }
      catch (error) { if (error instanceof CdpError) throw staleRef(); throw error; }
    };
    const center = async (target: { sessionId: string; backendNodeId: number }, callSignal: AbortSignal) => {
      try {
        await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, target.sessionId, callSignal);
        const { quads } = await send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: target.backendNodeId }, target.sessionId, callSignal);
        const quad = quads[0];
        if (!quad || quad.length < 8) throw new MayuraError('INVALID_INPUT', 'That element is not visible, so it cannot be clicked.');
        return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
      } catch (error) { if (error instanceof CdpError) throw staleRef(); throw error; }
    };
    const call = async (target: { sessionId: string; backendNodeId: number }, fn: string, args: readonly unknown[], callSignal: AbortSignal) => {
      const objectId = await resolve(target, callSignal);
      const reply = await send<{ result: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.callFunctionOn',
        { objectId, functionDeclaration: fn, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true }, target.sessionId, callSignal);
      if (reply.exceptionDetails) throw new MayuraError('INVALID_INPUT', 'The element refused the action.');
      return reply.result.value;
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));

    const browser: Browser = Object.freeze({
      id: backend.id, provider: id, features,
      get ended() { return ended || Date.now() >= expiresAt; },
      ...(features.liveView && typeof backend.liveViewUrl === 'string' && /^https:\/\//u.test(backend.liveViewUrl) ? { liveViewUrl: backend.liveViewUrl } : {}),
      goto: async (url: string, callOptions: CallOptions = {}) => { const href = checkUrl(url); return run(callOptions.signal, callSignal => {
        const tab = current();
        return navigated(tab, callSignal, async () => {
          const reply = await send<{ loaderId?: string; errorText?: string }>('Page.navigate', { url: href }, tab.sessionId, callSignal, navigationTimeoutMs);
          return { ...(reply.errorText ? { errorText: reply.errorText } : {}), sameDocument: reply.loaderId === undefined && !reply.errorText };
        });
      }, navigationTimeoutMs + 5_000); },
      back: (callOptions: CallOptions = {}) => run(callOptions.signal, async callSignal => history(-1, callSignal), navigationTimeoutMs + 5_000),
      forward: (callOptions: CallOptions = {}) => run(callOptions.signal, async callSignal => history(1, callSignal), navigationTimeoutMs + 5_000),
      reload: (callOptions: CallOptions = {}) => run(callOptions.signal, callSignal => {
        const tab = current(); return navigated(tab, callSignal, async () => { await send('Page.reload', {}, tab.sessionId, callSignal); });
      }, navigationTimeoutMs + 5_000),
      snapshot: (callOptions: CallOptions = {}) => run(callOptions.signal, async callSignal => {
        const tab = current();
        const { nodes } = await send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {}, tab.sessionId, callSignal);
        const result = outline(nodes, maxTextBytes);
        refs = new Map([...result.refs].map(([ref, backendNodeId]) => [ref, { sessionId: tab.sessionId, backendNodeId }]));
        const dialogs = tab.dialogs.splice(0);
        return { ...(await state(tab, callSignal)), text: result.text, truncated: result.truncated, dialogs };
      }),
      text: (callOptions: CallOptions & { readonly ref?: string } = {}) => run(callOptions.signal, async callSignal => {
        const tab = current(); let value: unknown;
        if (callOptions.ref !== undefined) value = await call(node(callOptions.ref), 'function () { return this.innerText ?? this.textContent ?? ""; }', [], callSignal);
        else {
          const reply = await send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, tab.sessionId, callSignal);
          value = reply.result.value;
        }
        return { ...(await state(tab, callSignal)), ...clip(typeof value === 'string' ? value : '', maxTextBytes) };
      }),
      click: (ref: string, callOptions: CallOptions & { readonly double?: boolean } = {}) => run(callOptions.signal, async callSignal => {
        const target = node(ref); const { x, y } = await center(target, callSignal); const count = callOptions.double ? 2 : 1;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, target.sessionId, callSignal);
        for (let click = 1; click <= count; click++) {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: click }, target.sessionId, callSignal);
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: click }, target.sessionId, callSignal);
        }
        await settle(); return state(current(), callSignal);
      }),
      fill: async (ref: string, text: string, callOptions: CallOptions = {}) => {
        if (typeof text !== 'string' || text.length > 1_000_000) throw new MayuraError('INVALID_INPUT', 'text is at most 1,000,000 characters.');
        return run(callOptions.signal, async callSignal => {
          const target = node(ref);
          const editable = await call(target, `function () {
            if (this.disabled || this.readOnly) return false;
            this.focus();
            if (typeof this.select === 'function' && 'value' in this) { this.select(); return true; }
            if (this.isContentEditable) { const range = document.createRange(); range.selectNodeContents(this); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; }
            return false;
          }`, [], callSignal);
          if (editable !== true) throw new MayuraError('INVALID_INPUT', 'That element does not take text.');
          if (text === '') await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, target.sessionId, callSignal)
            .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, target.sessionId, callSignal));
          else await send('Input.insertText', { text }, target.sessionId, callSignal);
          await settle(); return state(current(), callSignal);
        });
      },
      press: async (keys: string, callOptions: CallOptions = {}) => { const { key, modifiers } = parseKeys(keys); return run(callOptions.signal, async callSignal => {
        const tab = current(); const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers };
        await send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text } : {}) }, tab.sessionId, callSignal);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, tab.sessionId, callSignal);
        await settle(); return state(current(), callSignal);
      }); },
      select: async (ref: string, option: string, callOptions: CallOptions = {}) => {
        if (typeof option !== 'string' || option.length > 4_096) throw new MayuraError('INVALID_INPUT', 'option is the value or label of an option.');
        return run(callOptions.signal, async callSignal => {
          const target = node(ref);
          const chosen = await call(target, `function (wanted) {
            if (!(this instanceof HTMLSelectElement) || this.disabled) return 'not-select';
            const match = [...this.options].find(item => item.value === wanted) ?? [...this.options].find(item => item.label.trim() === wanted.trim());
            if (!match || match.disabled) return 'no-option';
            this.value = match.value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
          }`, [option], callSignal);
          if (chosen === 'not-select') throw new MayuraError('INVALID_INPUT', 'That element is not a list to choose from.');
          if (chosen !== 'ok') throw new MayuraError('INVALID_INPUT', 'That list has no such option.');
          await settle(); return state(current(), callSignal);
        });
      },
      hover: (ref: string, callOptions: CallOptions = {}) => run(callOptions.signal, async callSignal => {
        const target = node(ref); const { x, y } = await center(target, callSignal);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, target.sessionId, callSignal);
        await settle(); return state(current(), callSignal);
      }),
      scroll: async (dy: number, callOptions: CallOptions & { readonly ref?: string } = {}) => {
        if (!Number.isSafeInteger(dy) || Math.abs(dy) > 100_000) throw new MayuraError('INVALID_INPUT', 'dy is a whole number of pixels, at most 100,000 either way.');
        return run(callOptions.signal, async callSignal => {
          const tab = current();
          const at = callOptions.ref === undefined ? { x: viewport.width / 2, y: viewport.height / 2 } : await center(node(callOptions.ref), callSignal);
          await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: dy }, tab.sessionId, callSignal);
          await settle(); return state(tab, callSignal);
        });
      },
      screenshot: (callOptions: CallOptions & { readonly fullPage?: boolean } = {}) => run(callOptions.signal, async callSignal => {
        const tab = current();
        const { data } = await send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: callOptions.fullPage === true }, tab.sessionId, callSignal);
        if (typeof data !== 'string') throw new BrowserError('invalid_response');
        if (data.length * 0.75 > maxScreenshotBytes) throw new MayuraError('LIMIT_EXCEEDED', `The screenshot is larger than ${maxScreenshotBytes} bytes.`);
        return { data: fromBase64(data), mediaType: 'image/png' as const };
      }),
      evaluate: async (expression: string, callOptions: CallOptions = {}) => {
        if (typeof expression !== 'string' || expression.length === 0 || expression.length > 100_000) throw new MayuraError('INVALID_INPUT', 'expression is JavaScript, at most 100,000 characters.');
        return run(callOptions.signal, async callSignal => {
          const tab = current();
          const reply = await send<{ result: { value?: unknown; type?: string }; exceptionDetails?: { exception?: { description?: unknown }; text?: unknown } }>('Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true, timeout: callTimeoutMs, userGesture: false }, tab.sessionId, callSignal);
          if (reply.exceptionDetails) {
            const description = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text;
            return { error: clip(typeof description === 'string' ? description : 'The expression threw.', 4_096).text };
          }
          const json = JSON.stringify(reply.result.value ?? null);
          if (encoder.encode(json).byteLength > maxTextBytes) throw new MayuraError('LIMIT_EXCEEDED', `The value is larger than ${maxTextBytes} bytes of JSON.`);
          return { value: reply.result.value ?? null };
        });
      },
      tabs: (callOptions: CallOptions = {}) => run(callOptions.signal, async callSignal => Promise.all([...tabs.values()].map(async tab => ({ ...(await state(tab, callSignal)), active: tab.targetId === active })))),
      newTab: async (url?: string, callOptions: CallOptions = {}) => {
        const href = url === undefined ? undefined : checkUrl(url);
        return run(callOptions.signal, async callSignal => {
          if (tabs.size >= maxTabs) throw new MayuraError('LIMIT_EXCEEDED', `A browser has at most ${maxTabs} tabs.`);
          const { targetId } = await send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', ...(context ? { browserContextId: context } : {}) }, undefined, callSignal);
          for (let wait = 0; !tabs.has(targetId) && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 20));
          const tab = tabs.get(targetId); if (!tab) throw new BrowserError('invalid_response');
          active = targetId; refs = new Map();
          if (href === undefined) return state(tab, callSignal);
          return navigated(tab, callSignal, async () => {
            const reply = await send<{ loaderId?: string; errorText?: string }>('Page.navigate', { url: href }, tab.sessionId, callSignal, navigationTimeoutMs);
            return { ...(reply.errorText ? { errorText: reply.errorText } : {}), sameDocument: false };
          });
        }, navigationTimeoutMs + 5_000);
      },
      selectTab: (tab: string, callOptions: CallOptions = {}) => run(callOptions.signal, async callSignal => {
        const found = typeof tab === 'string' ? tabs.get(tab) : undefined;
        if (!found) throw new MayuraError('INVALID_INPUT', 'No such tab: list them with tabs.');
        active = found.targetId; refs = new Map();
        await send('Target.activateTarget', { targetId: found.targetId }, undefined, callSignal).catch(() => undefined);
        return state(found, callSignal);
      }),
      closeTab: (tab: string, callOptions: CallOptions = {}) => run(callOptions.signal, async callSignal => {
        const found = typeof tab === 'string' ? tabs.get(tab) : undefined;
        if (!found) throw new MayuraError('INVALID_INPUT', 'No such tab: list them with tabs.');
        if (tabs.size === 1) throw new MayuraError('INVALID_INPUT', 'The last tab stays open; release the browser to end it.');
        await send('Target.closeTarget', { targetId: found.targetId }, undefined, callSignal);
        tabs.delete(found.targetId); if (active === found.targetId) { active = tabs.keys().next().value; refs = new Map(); }
      }),
      release: (callOptions: CallOptions = {}) => release(callOptions.signal),
    });
    async function history(delta: number, callSignal: AbortSignal): Promise<NavigationResult> {
      const tab = current();
      const { currentIndex, entries } = await send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory', {}, tab.sessionId, callSignal);
      const entry = entries[currentIndex + delta];
      if (!entry) throw new MayuraError('INVALID_INPUT', delta < 0 ? 'There is no page to go back to.' : 'There is no page to go forward to.');
      return navigated(tab, callSignal, async () => { await send('Page.navigateToHistoryEntry', { entryId: entry.id }, tab.sessionId, callSignal); });
    }
    return browser;
  };

  return Object.freeze({
    provider: id, features,
    get size() { return alive.size; },
    open: async (openOptions: CallOptions & { readonly lifetimeMs?: number; readonly labels?: Readonly<Record<string, string>> } = {}) => {
      if (closed) throw new MayuraError('INVALID_INPUT', 'These browsers are closed.');
      const caller = openOptions.signal;
      if (caller !== undefined && !(caller instanceof AbortSignal)) throw new MayuraError('INVALID_INPUT', 'signal must be an AbortSignal.');
      if (caller?.aborted) throw cancelled();
      const lifetimeMs = openOptions.lifetimeMs ?? maxLifetimeMs;
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1_000 || lifetimeMs > maxLifetimeMs) throw new MayuraError('INVALID_INPUT', `lifetimeMs must be from 1,000 to ${maxLifetimeMs}.`);
      const spec = Object.freeze({ lifetimeMs, viewport: Object.freeze({ ...viewport }), labels: Object.freeze({ ...baseLabels, ...labels(openOptions.labels) }) });
      if (alive.size + pending >= maxBrowsers) throw new MayuraError('LIMIT_EXCEEDED', `At most ${maxBrowsers} browsers may be open at once.`);
      pending++;
      const timeout = AbortSignal.timeout(Math.max(callTimeoutMs, 120_000));
      const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
      let backend: BrowserBackend | undefined;
      try {
        backend = await provider.create(spec, { signal });
        return await drive(backend, lifetimeMs, signal);
      } catch (error) {
        if (backend) await Promise.resolve().then(() => backend!.release({ signal: AbortSignal.timeout(30_000) })).catch(() => undefined);
        if (caller?.aborted) throw cancelled();
        if (timeout.aborted) throw new BrowserError('timeout');
        if (error instanceof MayuraError) throw error;
        throw new BrowserError('unavailable');
      } finally { pending--; }
    },
    close: async () => {
      closed = true;
      const results = await Promise.allSettled([...alive].map(entry => entry.release()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
    },
  });
}
