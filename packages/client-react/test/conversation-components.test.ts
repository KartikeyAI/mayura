import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientError, createClient, type RemoteApproval, type RemoteRun, type RemoteThreadEntry } from '../../client/src/index.js';
import { createHeadlessThreadStore, createRunApprovalController } from '../../client/src/headless.js';
import { MayuraRunApprovalControl, MayuraThreadHistory } from '../src/components.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dom: JSDOM; let root: Root; let element: HTMLDivElement;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'); const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mayura.test' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window }); Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  element = dom.window.document.querySelector<HTMLDivElement>('#root')!; root = createRoot(element);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); dom.window.close();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
});
const now = Date.now(); const createdAt = '2026-10-19T00:00:00.000Z';
const approval: RemoteApproval = { callId: 'call1', toolId: 'refund', toolVersion: '1', input: { note: '<img src=x onerror=alert(1)>', amount: 12 }, digest: 'a'.repeat(64), expiresAtMs: now + 600_000 };
function fixture(entries: readonly RemoteThreadEntry[] = [], lastSequence = entries.at(-1)?.sequence ?? 0) {
  let fail = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async url => {
    if (fail) return new Response(JSON.stringify({ error: { code: 'CONVERSATION_UNAVAILABLE' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    const value = String(url).includes('/entries?') ? { entries } : { thread: { id: 'chat', agentId: 'support', title: 'Refund', metadata: {}, status: 'active', version: 1,
      createdAt, updatedAt: createdAt, entryCount: lastSequence, lastSequence, activeTurnId: null } };
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  });
  const client = createClient({ baseUrl: 'https://mayura.test', token: () => 'test', fetch });
  return { store: createHeadlessThreadStore({ client, threadId: 'chat' }), fetch, fail: () => { fail = true; } };
}
function controller(approve = vi.fn<RemoteRun['approve']>(async () => {}), captured: RemoteApproval = approval) {
  return { value: createRunApprovalController({ run: { approve }, approval: captured }), approve };
}
const click = (button: HTMLButtonElement) => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('thread history component', () => {
  it('is inert during SSR, StrictMode, mounting and unmounting', async () => {
    const { store, fetch } = fixture(); const node = createElement(MayuraThreadHistory, { store });
    expect(renderToString(node)).toContain('History not loaded'); expect(fetch).not.toHaveBeenCalled();
    await act(async () => { root.render(createElement(StrictMode, null, node)); }); expect(fetch).not.toHaveBeenCalled();
    await act(async () => { await store.refresh(); }); expect(element.textContent).toContain('No conversation entries on this page');
    await act(async () => { root.render(null); }); expect(store.getSnapshot().status).toBe('ready'); store.dispose();
  });

  it('shows every entry kind in sequence as inert text and hides internal recording markers', async () => {
    const base = { turnId: 'turn', createdAt };
    const entries: readonly RemoteThreadEntry[] = [
      { ...base, sequence: 1, kind: 'run', runId: 'run', status: 'running', recording: true },
      { ...base, sequence: 2, kind: 'user', content: '<script>unsafe()</script>', mediaOmitted: 1 },
      { ...base, sequence: 3, kind: 'tool_calls', calls: [{ id: 'c1', toolId: 'refund', input: { amount: 12 } }] },
      { ...base, sequence: 4, kind: 'approval', callId: 'c1', toolId: 'refund', decision: 'approved', actorId: 'alice' },
      { ...base, sequence: 5, kind: 'tool_result', callId: 'c1', toolId: 'refund', result: { done: true } },
      { ...base, sequence: 6, kind: 'assistant', output: '[click](javascript:unsafe())' },
      { ...base, sequence: 7, kind: 'summary', content: 'Summary', covers: { from: 2, to: 6 } },
      { ...base, sequence: 8, kind: 'run', runId: 'run', status: 'succeeded' },
    ];
    const { store } = fixture(entries); await store.refresh();
    await act(async () => { root.render(createElement(MayuraThreadHistory, { store })); });
    expect(element.querySelector('ol')?.start).toBe(2);
    expect([...element.querySelectorAll('li')].map(item => item.value)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(element.querySelector('script, a')).toBeNull(); expect(element.textContent).toContain('<script>unsafe()</script>');
    expect(element.textContent).toContain('approved by alice'); expect(element.textContent).toContain('1 media item omitted');
    expect(element.querySelector('time')?.dateTime).toBe(createdAt); store.dispose();
  });

  it('marks truncation and omitted content, and preserves the last loaded page after refresh failure', async () => {
    const base = { turnId: 'turn', createdAt };
    const { store, fail } = fixture([{ ...base, sequence: 1, kind: 'assistant', output: 'abcdefghij' },
      { ...base, sequence: 2, kind: 'tool_calls', calls: null, omitted: 'too_large' }]); await store.refresh();
    await act(async () => { root.render(createElement(MayuraThreadHistory, { store, maxContentChars: 5 })); });
    expect(element.querySelector('pre')?.textContent).toBe('abcde'); expect(element.textContent).toContain('Display truncated');
    expect(element.textContent).toContain('Content omitted from the saved history');
    fail(); await act(async () => { await expect(store.refresh()).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' }); });
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Showing the last loaded page'); expect(element.querySelectorAll('li')).toHaveLength(2); store.dispose();
  });

  it('emits explicit page bounds including hidden markers and stops paging after disposal', async () => {
    const { store } = fixture([{ turnId: 'turn', createdAt, sequence: 4, kind: 'run', runId: 'run', status: 'running', recording: true },
      { turnId: 'turn', createdAt, sequence: 5, kind: 'assistant', output: 'Page' }], 10);
    await store.refresh(); const onLoadEarlier = vi.fn(); const onLoadLater = vi.fn();
    await act(async () => { root.render(createElement(MayuraThreadHistory, { store, onLoadEarlier, onLoadLater })); });
    expect(onLoadEarlier).not.toHaveBeenCalled(); await act(async () => { click(element.querySelector('button')!); });
    expect(onLoadEarlier).toHaveBeenCalledWith({ before: 4 });
    await act(async () => { click(element.querySelectorAll<HTMLButtonElement>('button')[1]!); }); expect(onLoadLater).toHaveBeenCalledWith({ after: 5 });
    await act(async () => { store.dispose(); }); expect(element.textContent).toContain('History view closed');
    await act(async () => { click(element.querySelector('button')!); }); expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid labels and presentation limits', () => {
    const { store } = fixture();
    for (const props of [{ label: '' }, { maxContentChars: 0 }, { maxContentChars: 65_537 }]) {
      expect(() => renderToString(createElement(MayuraThreadHistory, { store, ...props }))).toThrowError(expect.objectContaining({ code: 'INVALID_COMPONENT_PROPS' }));
    } store.dispose();
  });
});

describe('run approval control', () => {
  it('renders exact tool input as text with distinct labels and no decisions on SSR or mount', async () => {
    const { value, approve } = controller(); const node = createElement(MayuraRunApprovalControl, { controller: value, nowMs: now });
    expect(renderToString(node)).toContain('Awaiting your decision'); expect(approve).not.toHaveBeenCalled();
    await act(async () => { root.render(createElement(StrictMode, null, node)); });
    expect(approve).not.toHaveBeenCalled(); expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('pre')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(element.querySelector('button')?.getAttribute('aria-label')).toBe('Approve for refund, call call1');
    const area = element.querySelector('textarea')!; expect(element.querySelector('label')?.htmlFor).toBe(area.id);
    await act(async () => { root.render(null); }); expect(value.getSnapshot().status).toBe('idle'); value.dispose();
  });

  it.each(['approved', 'rejected'] as const)('submits an exact %s decision with a reason once and keeps focus while pending', async decision => {
    const pending = deferred(); const approve = vi.fn<RemoteRun['approve']>(async () => pending.promise); const { value } = controller(approve);
    await act(async () => { root.render(createElement(MayuraRunApprovalControl, { controller: value, nowMs: now })); });
    element.querySelector('textarea')!.value = 'Reviewed by operator';
    const buttons = element.querySelectorAll<HTMLButtonElement>('button'); const selected = buttons[decision === 'approved' ? 0 : 1]!;
    selected.focus(); await act(async () => { click(selected); click(selected); click(buttons[decision === 'approved' ? 1 : 0]!); });
    expect(approve).toHaveBeenCalledTimes(1); expect(approve.mock.calls[0]?.[0]).toEqual({ callId: approval.callId, digest: approval.digest, decision, reason: 'Reviewed by operator' });
    expect(element.querySelector('section')?.getAttribute('aria-busy')).toBe('true'); expect(dom.window.document.activeElement).toBe(selected);
    expect(selected.getAttribute('aria-disabled')).toBe('true'); expect(element.querySelector('textarea')!.disabled).toBe(true);
    await act(async () => { pending.resolve(); await pending.promise; }); expect(element.textContent).toContain('Decision submitted');
    await act(async () => { click(selected); }); expect(approve).toHaveBeenCalledTimes(1); value.dispose();
  });

  it.each(['APPROVAL_CONFLICT', 'CAPABILITY_REQUIRED', 'CONVERSATION_UNAVAILABLE', 'TRANSPORT_FAILED'])('shows %s feedback and requires inspection before another decision', async code => {
    const approve = vi.fn<RemoteRun['approve']>(async () => { throw new ClientError(code); }); const { value } = controller(approve);
    await act(async () => { root.render(createElement(MayuraRunApprovalControl, { controller: value, nowMs: now })); });
    const button = element.querySelector('button')!; await act(async () => { click(button); });
    expect(element.querySelector('[role="status"]')?.textContent).toContain('refresh the run');
    await act(async () => { click(button); }); expect(approve).toHaveBeenCalledTimes(1); expect(button.getAttribute('aria-disabled')).toBe('true'); value.dispose();
  });

  it('blocks expired and disposed controls and validates the caller clock', async () => {
    const { value, approve } = controller();
    await act(async () => { root.render(createElement(MayuraRunApprovalControl, { controller: value, nowMs: approval.expiresAtMs })); });
    await act(async () => { click(element.querySelector('button')!); }); expect(approve).not.toHaveBeenCalled(); expect(element.textContent).toContain('Approval expired');
    await act(async () => { value.dispose(); }); expect(element.textContent).toContain('Approval controller closed');
    await act(async () => { click(element.querySelectorAll<HTMLButtonElement>('button')[1]!); }); expect(approve).not.toHaveBeenCalled();
    expect(() => renderToString(createElement(MayuraRunApprovalControl, { controller: value, nowMs: NaN }))).toThrowError(expect.objectContaining({ code: 'INVALID_COMPONENT_PROPS' }));
  });

  it('blocks approval of truncated input while leaving rejection available', async () => {
    const { value, approve } = controller(); await act(async () => { root.render(createElement(MayuraRunApprovalControl, { controller: value, nowMs: now, maxInputChars: 5 })); });
    const buttons = element.querySelectorAll<HTMLButtonElement>('button'); await act(async () => { click(buttons[0]!); }); expect(approve).not.toHaveBeenCalled();
    expect(element.textContent).toContain('Input truncated'); await act(async () => { click(buttons[1]!); }); expect(approve.mock.calls[0]?.[0].decision).toBe('rejected'); value.dispose();
  });

  it('rejects an overlong reason locally and clears the draft when the pending request changes', async () => {
    const first = controller(); const second = controller(undefined, { ...approval, callId: 'call2', digest: 'b'.repeat(64) });
    await act(async () => { root.render(createElement(MayuraRunApprovalControl, { controller: first.value, nowMs: now })); });
    element.querySelector('textarea')!.value = 'x'.repeat(1_001); await act(async () => { click(element.querySelector('button')!); });
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('1,000'); expect(first.approve).not.toHaveBeenCalled();
    await act(async () => { root.render(createElement(MayuraRunApprovalControl, { controller: second.value, nowMs: now })); });
    expect(element.querySelector('textarea')!.value).toBe(''); expect(element.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { click(element.querySelector('button')!); }); expect(second.approve.mock.calls[0]?.[0]).toMatchObject({ callId: 'call2', digest: 'b'.repeat(64) });
    expect(first.approve).not.toHaveBeenCalled(); first.value.dispose(); second.value.dispose();
  });
});


it('gives multiple approval controls distinct field ids and caller-provided button context', async () => {
  const first = controller(); const second = controller(undefined, { ...approval, callId: 'call2', digest: 'b'.repeat(64) });
  await act(async () => { root.render(createElement('div', null,
    createElement(MayuraRunApprovalControl, { controller: first.value, nowMs: now, subject: 'first run' }),
    createElement(MayuraRunApprovalControl, { controller: second.value, nowMs: now, subject: 'second run' }))); });
  const ids = [...element.querySelectorAll('[id]')].map(node => node.id); expect(new Set(ids).size).toBe(ids.length);
  expect([...element.querySelectorAll('button')].map(node => node.getAttribute('aria-label'))).toEqual(['Approve for first run', 'Reject for first run', 'Approve for second run', 'Reject for second run']);
  first.value.dispose(); second.value.dispose();
});


it('preserves JSON input types so string values cannot be mistaken for objects or booleans', () => {
  for (const input of ['{}', 'true', null, false]) {
    const { value } = controller(undefined, { ...approval, input });
    const html = renderToString(createElement(MayuraRunApprovalControl, { controller: value, nowMs: now }));
    const rendered = new JSDOM(html); expect(rendered.window.document.querySelector('pre')?.textContent).toBe(JSON.stringify(input, null, 2)); rendered.window.close(); value.dispose();
  }
});
