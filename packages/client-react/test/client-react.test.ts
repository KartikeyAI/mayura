import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHeadlessRunStore, type HeadlessRunState, type HeadlessRunStore } from '../../client/src/headless.js';
import type { RemoteHumanRequest, RemoteRun, RemoteSnapshot } from '../../client/src/index.js';
import { MayuraReactError, useMayuraHumanRequest, useMayuraRun, useMayuraRunActions, useMayuraRunActivity, type MayuraRunActions } from '../src/index.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let dom: JSDOM; let root: Root; let element: HTMLDivElement;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'); const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
beforeEach(() => { dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mayura.test/' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window }); Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  element = dom.window.document.querySelector<HTMLDivElement>('#root')!; root = createRoot(element); });
afterEach(async () => { await act(async () => { root.unmount(); }); dom.window.close();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document'); });
function snapshot(status: RemoteSnapshot['status'] = 'running'): RemoteSnapshot { return Object.freeze({ id, status,
  budget: Object.freeze({ spentMicros: 0, reservedMicros: 0, calls: 0 }), evidence: Object.freeze([]) }); }
function remote(inspect: () => Promise<RemoteSnapshot>): RemoteRun { return Object.freeze({ id, inspect, cancel: async () => {}, result: async () => undefined, events: async function* () {} }); }

describe('@mayura/client-react', () => {
  it('subscribes to a caller-owned store without implicit network work and keeps actions stable', async () => {
    let reads = 0; const store = createHeadlessRunStore({ run: remote(async () => { reads += 1; return snapshot(); }) });
    const states: HeadlessRunState[] = []; const actions: MayuraRunActions[] = [];
    function View(): ReactNode { const state = useMayuraRun(store); states.push(state); actions.push(useMayuraRunActions(store)); return createElement('span', null, state.connection); }
    await act(async () => { root.render(createElement(View)); });
    expect(reads).toBe(0); expect(element.textContent).toBe('idle'); const firstActions = actions.at(-1)!;
    await act(async () => { await firstActions.refresh(); });
    expect(reads).toBe(1); expect(element.textContent).toBe('stopped'); expect(actions.at(-1)).toBe(firstActions);
    await act(async () => { store.dispose(); }); expect(states.length).toBeGreaterThanOrEqual(2);
  });

  it('shares one store subscription across state and action hooks without starting observation', async () => {
    let subscriptions = 0; const base = createHeadlessRunStore({ run: remote(async () => snapshot()) });
    const observed: HeadlessRunStore = Object.freeze({ ...base, subscribe: (listener: () => void) => { subscriptions += 1; return base.subscribe(listener); } });
    function View(): ReactNode { useMayuraRunActions(observed); const state = useMayuraRun(observed); return createElement('span', null, state.connection); }
    await act(async () => { root.render(createElement(View)); }); expect(subscriptions).toBe(1); await act(async () => { base.dispose(); });
  });

  it('derives human presentation directly from immutable request props', async () => {
    const request: RemoteHumanRequest = Object.freeze({ id: 'review', agentId: 'agent', kind: 'information', schemaId: 'answer-v1',
      schemaDigest: 'a'.repeat(64), prompt: '<b>Untrusted</b>', digest: 'b'.repeat(64), status: 'waiting', deadlineAtMs: 2_000 });
    function View({ now }: { readonly now: number }): ReactNode { const view = useMayuraHumanRequest(request, now); return createElement('span', null, `${view.urgency}:${view.prompt}`); }
    await act(async () => { root.render(createElement(View, { now: 1_000 })); }); expect(element.textContent).toBe('due_soon:<b>Untrusted</b>');
    await act(async () => { root.render(createElement(View, { now: 2_001 })); }); expect(element.textContent).toBe('expired:<b>Untrusted</b>');
  });

  it('uses the inert snapshot during server rendering without subscribing or reading remotely', () => {
    let subscriptions = 0; let reads = 0; const base = createHeadlessRunStore({ run: remote(async () => { reads += 1; return snapshot(); }) });
    const observed: HeadlessRunStore = Object.freeze({ ...base, subscribe: (listener: () => void) => { subscriptions += 1; return base.subscribe(listener); } });
    function View(): ReactNode { return createElement('span', null, useMayuraRun(observed).connection); }
    expect(renderToString(createElement(View))).toContain('idle'); expect(subscriptions).toBe(0); expect(reads).toBe(0); base.dispose();
  });

  it('rejects a forged store before registering a React subscription', () => {
    const forged = Object.freeze({}) as HeadlessRunStore;
    function View(): ReactNode { useMayuraRun(forged); return null; }
    expect(() => renderToString(createElement(View))).toThrowError(expect.objectContaining<Partial<MayuraReactError>>({ code: 'INVALID_REACT_STORE' }));
  });

  it('derives activity from the subscribed immutable state without another subscription', async () => {
    let subscriptions = 0; const base = createHeadlessRunStore({ run: remote(async () => snapshot()) });
    const observed: HeadlessRunStore = Object.freeze({ ...base, subscribe: (listener: () => void) => { subscriptions += 1; return base.subscribe(listener); } });
    function View(): ReactNode { const state = useMayuraRun(observed); return createElement('span', null, `${useMayuraRunActivity(state).items.length}`); }
    await act(async () => { root.render(createElement(View)); }); expect(element.textContent).toBe('0'); expect(subscriptions).toBe(1);
    await act(async () => { base.dispose(); });
  });
});
