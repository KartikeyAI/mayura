import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessRunStore } from '../../client/src/headless.js';
import type { RemoteHumanRequest, RemoteRun, RemoteSnapshot } from '../../client/src/index.js';
import { defineHumanResponseForm } from '@mayura/client/forms';
import { MayuraHumanRequestCard, MayuraHumanResponseForm, MayuraRunSummary, MayuraWorkflowGraph } from '../src/components.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let dom: JSDOM; let root: Root; let element: HTMLDivElement;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'); const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalFormData = Object.getOwnPropertyDescriptor(globalThis, 'FormData');
beforeEach(() => { dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mayura.test/' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window }); Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'FormData', { configurable: true, value: dom.window.FormData });
  element = dom.window.document.querySelector<HTMLDivElement>('#root')!; root = createRoot(element); });
afterEach(async () => { await act(async () => { root.unmount(); }); dom.window.close();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  if (originalFormData) Object.defineProperty(globalThis, 'FormData', originalFormData); else Reflect.deleteProperty(globalThis, 'FormData'); });
function snapshot(): RemoteSnapshot { return Object.freeze({ id, status: 'running', budget: Object.freeze({ spentMicros: 0, reservedMicros: 0, calls: 0 }), evidence: Object.freeze([]) }); }
function remote(inspect: () => Promise<RemoteSnapshot>): RemoteRun { return Object.freeze({ id, inspect, cancel: async () => {}, result: async () => undefined, events: async function* () {} }); }
const request = (overrides: Partial<RemoteHumanRequest> = {}): RemoteHumanRequest => Object.freeze({ id: 'review', agentId: 'agent', kind: 'information', schemaId: 'answer-v1',
  schemaDigest: 'a'.repeat(64), prompt: '<img src=x onerror=alert(1)>', digest: 'b'.repeat(64), status: 'waiting', deadlineAtMs: 2_000, ...overrides });
const graph = Object.freeze({ format: 4 as const, definitionId: 'workflow', definitionVersion: '1', runId: 'a'.repeat(64), revision: 1, status: 'running' as const,
  nodes: Object.freeze([Object.freeze({ id: 'prepare', kind: 'tool' as const, dependsOn: Object.freeze([]) }), Object.freeze({ id: 'child', kind: 'child' as const, dependsOn: Object.freeze(['prepare']) })]),
  steps: Object.freeze([Object.freeze({ id: 'prepare', kind: 'tool' as const, status: 'succeeded' as const }), Object.freeze({ id: 'child', kind: 'child' as const, status: 'pending' as const })]) });
const formDefinition = () => defineHumanResponseForm({ schemaId: 'answer-v1', schemaDigest: 'a'.repeat(64), fields: [
  { kind: 'text', name: 'summary', label: '<b>Summary</b>', required: true, minLength: 2 },
  { kind: 'integer', name: 'risk', label: 'Risk', required: true, minimum: 1, maximum: 5 },
  { kind: 'boolean', name: 'approved', label: 'Approved' },
  { kind: 'select', name: 'region', label: 'Region', required: true, options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'United States' }] },
] });

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

  it('submits a typed digest-bound response only from the explicit form event', async () => {
    const onSubmit = vi.fn(); await act(async () => { root.render(createElement(MayuraHumanResponseForm,
      { request: request(), definition: formDefinition(), nowMs: 1_000, onSubmit })); });
    expect(onSubmit).not.toHaveBeenCalled(); expect(element.querySelector('b')).toBeNull();
    const summary = element.querySelector<HTMLInputElement>('input[name="summary"]')!; const risk = element.querySelector<HTMLInputElement>('input[name="risk"]')!;
    const approved = element.querySelector<HTMLInputElement>('input[name="approved"]')!; const region = element.querySelector<HTMLSelectElement>('select[name="region"]')!;
    summary.value = 'Safe'; risk.value = '3'; approved.checked = true; region.value = 'eu';
    await act(async () => { element.querySelector('form')!.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })); });
    expect(onSubmit).toHaveBeenCalledOnce(); expect(onSubmit).toHaveBeenCalledWith({ id: 'review', digest: 'b'.repeat(64),
      value: { summary: 'Safe', risk: 3, approved: true, region: 'eu' } });
  });

  it('blocks invalid and expired form submissions without invoking the application callback', async () => {
    const onSubmit = vi.fn(); await act(async () => { root.render(createElement(MayuraHumanResponseForm,
      { request: request(), definition: formDefinition(), nowMs: 1_000, onSubmit })); });
    await act(async () => { element.querySelector('form')!.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })); });
    expect(onSubmit).not.toHaveBeenCalled(); expect(element.querySelector('[role="alert"]')?.textContent).toBe('Response values are invalid');
    await act(async () => { root.render(createElement(MayuraHumanResponseForm,
      { request: request({ deadlineAtMs: 999 }), definition: formDefinition(), nowMs: 1_000, onSubmit })); });
    expect(element.querySelector('fieldset')?.disabled).toBe(true); expect(element.querySelector('button')).toBeNull();
  });
});
