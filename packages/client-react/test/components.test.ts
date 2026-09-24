import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessRunStore } from '../../client/src/headless.js';
import type { RemoteHumanRequest, RemoteRun, RemoteSnapshot } from '../../client/src/index.js';
import { MayuraHumanRequestCard, MayuraRunSummary, MayuraWorkflowGraph } from '../src/components.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let dom: JSDOM; let root: Root; let element: HTMLDivElement;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'); const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
beforeEach(() => { dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mayura.test/' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window }); Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  element = dom.window.document.querySelector<HTMLDivElement>('#root')!; root = createRoot(element); });
afterEach(async () => { await act(async () => { root.unmount(); }); dom.window.close();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document'); });
function snapshot(): RemoteSnapshot { return Object.freeze({ id, status: 'running', budget: Object.freeze({ spentMicros: 0, reservedMicros: 0, calls: 0 }), evidence: Object.freeze([]) }); }
function remote(inspect: () => Promise<RemoteSnapshot>): RemoteRun { return Object.freeze({ id, inspect, cancel: async () => {}, result: async () => undefined, events: async function* () {} }); }
const request = (overrides: Partial<RemoteHumanRequest> = {}): RemoteHumanRequest => Object.freeze({ id: 'review', agentId: 'agent', kind: 'information', schemaId: 'answer-v1',
  schemaDigest: 'a'.repeat(64), prompt: '<img src=x onerror=alert(1)>', digest: 'b'.repeat(64), status: 'waiting', deadlineAtMs: 2_000, ...overrides });
const graph = Object.freeze({ format: 4 as const, definitionId: 'workflow', definitionVersion: '1', runId: 'a'.repeat(64), revision: 1, status: 'running' as const,
  nodes: Object.freeze([Object.freeze({ id: 'prepare', kind: 'tool' as const, dependsOn: Object.freeze([]) }), Object.freeze({ id: 'child', kind: 'child' as const, dependsOn: Object.freeze(['prepare']) })]),
  steps: Object.freeze([Object.freeze({ id: 'prepare', kind: 'tool' as const, status: 'succeeded' as const }), Object.freeze({ id: 'child', kind: 'child' as const, status: 'pending' as const })]) });

describe('accessible React components', () => {
  it('renders an inert run summary without remote inspection', () => {
    let reads = 0; const store = createHeadlessRunStore({ run: remote(async () => { reads += 1; return snapshot(); }) });
    const html = renderToString(createElement(MayuraRunSummary, { store }));
    expect(html).toContain('Run idle'); expect(html).toContain('No activity recorded'); expect(reads).toBe(0); store.dispose();
  });

  it('renders an ordered workflow with status semantics and dependencies', () => {
    const html = renderToString(createElement(MayuraWorkflowGraph, { input: graph }));
    expect(html).toContain('1 of 2 steps terminal'); expect(html).toContain('depends on prepare'); expect(html).toContain('aria-label="Workflow steps"');
  });

  it('renders hostile prompts as inert text and invokes the explicit response intent once', async () => {
    const onRespond = vi.fn(); await act(async () => { root.render(createElement(MayuraHumanRequestCard, { request: request(), nowMs: 1_000, onRespond })); });
    expect(element.querySelector('img')).toBeNull(); expect(element.querySelector('[data-mayura-prompt]')?.textContent).toBe('<img src=x onerror=alert(1)>');
    const button = element.querySelector('button')!; expect(button.type).toBe('button');
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    expect(onRespond).toHaveBeenCalledOnce(); expect(onRespond).toHaveBeenCalledWith({ id: 'review', digest: 'b'.repeat(64) });
  });

  it('omits response controls for expired/resolved requests and rejects invalid labels', () => {
    expect(renderToString(createElement(MayuraHumanRequestCard, { request: request(), nowMs: 2_001 }))).not.toContain('<button');
    expect(renderToString(createElement(MayuraHumanRequestCard, { request: request({ status: 'answered' }), nowMs: 1_000 }))).not.toContain('<button');
    expect(() => renderToString(createElement(MayuraWorkflowGraph, { input: graph, label: '' }))).toThrow(expect.objectContaining({ code: 'INVALID_COMPONENT_PROPS' }));
  });
});
