import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessRunStore } from '../../client/src/headless.js';
import type { RemoteHumanRequest, RemoteRun, RemoteSnapshot } from '../../client/src/index.js';
import { defineHumanResponseForm } from '@mayura/client/forms';
import { createWorkflowCommandController, type WorkflowViewInput } from '@mayura/client/workflows';
import { MayuraFleetHoldControl, MayuraWorkflowPauseControl } from '../src/components.js';
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

  it('renders bound command feedback and rejects state from another request', () => {
    const succeeded = Object.freeze({ revision: 2, status: 'succeeded' as const, requestId: 'review', requestDigest: 'b'.repeat(64),
      responseStatus: 'answered' as const, errorCode: null });
    const html = renderToString(createElement(MayuraHumanResponseForm,
      { request: request(), definition: formDefinition(), nowMs: 1_000, commandState: succeeded, onSubmit: () => {} }));
    expect(html).toContain('Response submitted'); expect(html).toContain('<fieldset disabled=""'); expect(html).not.toContain('type="submit"');
    expect(() => renderToString(createElement(MayuraHumanResponseForm,
      { request: request(), definition: formDefinition(), nowMs: 1_000, commandState: Object.freeze({ ...succeeded, requestId: 'other' }), onSubmit: () => {} })))
      .toThrow(expect.objectContaining({ code: 'INVALID_COMPONENT_PROPS' }));
  });

  it('renders an inert pause control and emits only explicit run-bound intent', async () => {
    const onPause = vi.fn(); const onResume = vi.fn();
    const html = renderToString(createElement(MayuraWorkflowPauseControl, { workflow: graph, onPause, onResume }));
    expect(html).toContain('Workflow running'); expect(html).toContain('Pause workflow'); expect(onPause).not.toHaveBeenCalled();
    await act(async () => { root.render(createElement(MayuraWorkflowPauseControl, { workflow: graph, onPause, onResume })); });
    const button = element.querySelector<HTMLButtonElement>('button')!;
    expect(button.getAttribute('data-action')).toBe('pause'); expect(button.getAttribute('aria-disabled')).toBe('false');
    await act(async () => { button.click(); });
    expect(onPause).toHaveBeenCalledWith({ runId: graph.runId, revision: 1 }); expect(onResume).not.toHaveBeenCalled();
    const paused = Object.freeze({ ...graph, revision: 2, status: 'paused' as const });
    await act(async () => { root.render(createElement(MayuraWorkflowPauseControl, { workflow: paused, onPause, onResume })); });
    expect(element.querySelector('[role="status"]')!.textContent).toBe('Workflow paused');
    await act(async () => { element.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(onResume).toHaveBeenCalledWith({ runId: graph.runId, revision: 2 });
    await act(async () => { root.render(createElement(MayuraWorkflowPauseControl, { workflow: Object.freeze({ ...graph, status: 'succeeded' as const }), onPause, onResume })); });
    expect(element.querySelector('button')).toBeNull();
  });

  it('keeps focus on a locked pause button while its command is in flight and reports unknown outcomes', async () => {
    let finish!: (value: WorkflowViewInput) => void; const pending = new Promise<WorkflowViewInput>(resolve => { finish = resolve; });
    const unused = async (): Promise<WorkflowViewInput> => { throw new Error('unused'); };
    const controller = createWorkflowCommandController({ workflow: graph, client: { cancelWorkflow: unused, approveWorkflow: unused, pauseWorkflow: () => pending } });
    const onPause = vi.fn(() => { void controller.pause({ commandId: 'pause-1' }).catch(() => undefined); });
    const render = () => act(async () => { root.render(createElement(MayuraWorkflowPauseControl, { workflow: graph, commandState: controller.getSnapshot(), onPause })); });
    await render(); const button = element.querySelector<HTMLButtonElement>('button')!; button.focus();
    await act(async () => { button.click(); }); await render();
    const locked = element.querySelector<HTMLButtonElement>('button')!;
    expect(locked).toBe(button); expect(dom.window.document.activeElement).toBe(button);
    expect(locked.getAttribute('aria-disabled')).toBe('true'); expect(element.querySelector('section')!.getAttribute('aria-busy')).toBe('true');
    expect(element.querySelector('[role="status"]')!.textContent).toBe('Workflow running. Pausing workflow');
    await act(async () => { locked.click(); }); expect(onPause).toHaveBeenCalledOnce();
    const paused = Object.freeze({ ...graph, revision: 2, status: 'paused' as const }); finish(paused); await act(async () => { await pending; });
    await act(async () => { root.render(createElement(MayuraWorkflowPauseControl, { workflow: paused, commandState: controller.getSnapshot(), onPause })); });
    expect(element.querySelector('[role="status"]')!.getAttribute('data-command-status')).toBe('succeeded');
    expect(element.querySelector('[role="status"]')!.textContent).toBe('Workflow paused. Pause applied');
    // An unknown outcome leaves the displayed revision unchanged, so its feedback stays visible.
    const failed = Object.freeze({ ...controller.getSnapshot(), status: 'failed' as const, workflowRevision: 1 });
    await act(async () => { root.render(createElement(MayuraWorkflowPauseControl, { workflow: graph, commandState: failed, onPause })); });
    expect(element.querySelector('[role="status"]')!.textContent).toBe('Workflow running. Command outcome unknown; refresh before retrying');
    expect(() => renderToString(createElement(MayuraWorkflowPauseControl, { workflow: Object.freeze({ ...graph, runId: 'f'.repeat(64) }), commandState: controller.getSnapshot() })))
      .toThrow(expect.objectContaining({ code: 'INVALID_COMPONENT_PROPS' }));
  });

  it('requires an explicit confirmation before holding the fleet and releases in one step', async () => {
    const onHold = vi.fn(); const onRelease = vi.fn(); const running = Object.freeze({ held: false, generation: 0, changedAtMs: null });
    await act(async () => { root.render(createElement(MayuraFleetHoldControl, { fleet: running, onHold, onRelease })); });
    expect(element.querySelector('[role="status"]')!.textContent).toBe('Fleet running');
    await act(async () => { element.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(onHold).not.toHaveBeenCalled(); const group = element.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('Confirm fleet hold');
    const [confirm, cancel] = [...group.querySelectorAll('button')]; expect(dom.window.document.activeElement).toBe(confirm);
    expect(confirm!.getAttribute('aria-describedby')).toBe('mayura-fleet-hold-warning');
    await act(async () => { cancel!.click(); }); expect(element.querySelector('[role="group"]')).toBeNull(); expect(onHold).not.toHaveBeenCalled();
    await act(async () => { element.querySelector<HTMLButtonElement>('button')!.click(); });
    await act(async () => { element.querySelector<HTMLButtonElement>('[role="group"] button')!.click(); }); expect(onHold).toHaveBeenCalledOnce();
    const held = Object.freeze({ held: true, generation: 1, changedAtMs: 5 });
    await act(async () => { root.render(createElement(MayuraFleetHoldControl, { fleet: held, status: 'submitting', onHold, onRelease })); });
    expect(element.querySelector('[role="status"]')!.textContent).toBe('Fleet held (generation 1); hosts and coordinators drive no runs. Updating fleet hold');
    const releaseButton = element.querySelector<HTMLButtonElement>('button')!; expect(releaseButton.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { releaseButton.click(); }); expect(onRelease).not.toHaveBeenCalled();
    await act(async () => { root.render(createElement(MayuraFleetHoldControl, { fleet: held, onHold, onRelease })); });
    await act(async () => { element.querySelector<HTMLButtonElement>('button')!.click(); }); expect(onRelease).toHaveBeenCalledOnce();
    expect(() => renderToString(createElement(MayuraFleetHoldControl, { fleet: { held: true, generation: -1, changedAtMs: null } })))
      .toThrow(expect.objectContaining({ code: 'INVALID_COMPONENT_PROPS' }));
  });

  it('hides stale command feedback once the view revision moves on and names buttons per run', async () => {
    const unused = async (): Promise<WorkflowViewInput> => { throw new Error('unused'); };
    const resumedView = Object.freeze({ ...graph, revision: 3, status: 'waiting' as const });
    const controller = createWorkflowCommandController({ workflow: Object.freeze({ ...graph, revision: 2, status: 'paused' as const }),
      client: { cancelWorkflow: unused, approveWorkflow: unused, resumeWorkflow: async () => resumedView } });
    await controller.resume({ commandId: 'resume-1' }); const state = controller.getSnapshot(); expect(state.workflowRevision).toBe(3);
    await act(async () => { root.render(createElement(MayuraWorkflowPauseControl, { workflow: resumedView, commandState: state, subject: 'run aaaaaaaa', onPause: vi.fn() })); });
    expect(element.querySelector('[role="status"]')!.textContent).toBe('Workflow waiting. Resume requested');
    expect(element.querySelector('button')!.getAttribute('aria-label')).toBe('Pause workflow for run aaaaaaaa');
    // A fleet sweep has since paused the run at a newer revision: the old resume feedback must not be shown.
    const swept = Object.freeze({ ...graph, revision: 4, status: 'paused' as const });
    await act(async () => { root.render(createElement(MayuraWorkflowPauseControl, { workflow: swept, commandState: state, subject: 'run aaaaaaaa', onResume: vi.fn() })); });
    expect(element.querySelector('[role="status"]')!.textContent).toBe('Workflow paused');
    expect(element.querySelector('button')!.getAttribute('aria-label')).toBe('Resume workflow for run aaaaaaaa');
  });

  it('returns focus to the primary fleet action after confirming, cancelling or changing hold state', async () => {
    const running = Object.freeze({ held: false, generation: 0, changedAtMs: null }); const held = Object.freeze({ held: true, generation: 1, changedAtMs: 5 });
    const render = (fleet: typeof running | typeof held) => act(async () => { root.render(createElement(MayuraFleetHoldControl, { fleet, onHold: vi.fn(), onRelease: vi.fn() })); });
    await render(running); const primary = element.querySelector<HTMLButtonElement>('button')!;
    await act(async () => { primary.click(); }); await act(async () => { element.querySelectorAll<HTMLButtonElement>('[role="group"] button')[1]!.click(); });
    expect(dom.window.document.activeElement?.textContent).toBe('Hold fleet');
    await act(async () => { element.querySelector<HTMLButtonElement>('button')!.click(); }); await act(async () => { element.querySelector<HTMLButtonElement>('[role="group"] button')!.click(); });
    const afterConfirm = dom.window.document.activeElement as HTMLButtonElement; expect(afterConfirm.textContent).toBe('Hold fleet');
    await render(held); expect(dom.window.document.activeElement).toBe(afterConfirm); expect(afterConfirm.textContent).toBe('Release fleet hold');
    await render(running); expect(dom.window.document.activeElement).toBe(afterConfirm); expect(afterConfirm.textContent).toBe('Hold fleet');
  });
});
