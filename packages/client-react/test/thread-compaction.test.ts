import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientError, type MayuraClient, type RemoteThreadCompaction, type RemoteThreadCompactionResult } from '../../client/src/index.js';
import { createThreadCompactionController, type ThreadCompactionController } from '../../client/src/headless.js';
import { MayuraThreadCompactionControl } from '../src/components.js';
import { useMayuraThreadCompactionCommand, useMayuraThreadCompactionActions, type MayuraThreadCompactionActions } from '../src/index.js';

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
const command = { commandId: 'summary/one', through: 3 }; const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const receipt = (content = '<script>untrusted()</script>'): RemoteThreadCompactionResult => ({ commandId: command.commandId, runId, costMicros: 0, reused: false,
  entry: { sequence: 5, turnId: 'executor', createdAt: '2026-10-20T00:00:00.000Z', kind: 'summary', content, covers: { from: 1, to: 3 },
    compaction: { format: 1, commandId: command.commandId, requestDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), sourceEntries: 3, sourceTurns: 1, agentId: 'summarizer', agentVersion: '1', modelRunId: runId, costMicros: 0 } } });
const progress = (status: RemoteThreadCompaction['status'] = 'pending'): RemoteThreadCompaction => ({ commandId: command.commandId, through: 3, status, maxCostMicros: 100,
  costMicros: ['ready', 'committed'].includes(status) ? 0 : null, entrySequence: status === 'committed' ? 5 : null });
function fixture() {
  const client = { compactThread: vi.fn<MayuraClient['compactThread']>(async () => receipt()),
    threadCompaction: vi.fn<MayuraClient['threadCompaction']>(async () => progress()),
    cancelThreadCompaction: vi.fn<MayuraClient['cancelThreadCompaction']>(async () => ({ status: 'cancelled' })) };
  return { client, controller: createThreadCompactionController({ client, threadId: 'chat', command }) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const click = (action: number) => element.querySelectorAll<HTMLButtonElement>('button')[action]!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const button = (action: number) => element.querySelectorAll<HTMLButtonElement>('button')[action]!;

describe('React compaction hooks', () => {
  it('subscribes without commands, preserves stable actions and leaves ownership with the caller', async () => {
    const { controller, client } = fixture(); let actions: MayuraThreadCompactionActions | undefined; let first: MayuraThreadCompactionActions | undefined;
    function View({ value }: { value: ThreadCompactionController }) {
      const state = useMayuraThreadCompactionCommand(value); actions = useMayuraThreadCompactionActions(value);
      return createElement('span', null, `${state.threadId}:${state.command.through}:${state.status}`);
    }
    expect(renderToString(createElement(View, { value: controller }))).toContain('chat:3:idle');
    await act(async () => { root.render(createElement(StrictMode, null, createElement(View, { value: controller }))); }); first = actions;
    await act(async () => { await controller.refresh(); }); expect(actions).toBe(first); expect(Object.isFrozen(actions)).toBe(true);
    expect(client.compactThread).not.toHaveBeenCalled(); expect(client.cancelThreadCompaction).not.toHaveBeenCalled();
    const other = fixture(); await act(async () => { root.render(createElement(View, { value: other.controller })); }); expect(actions).not.toBe(first);
    await act(async () => { root.render(null); }); expect(controller.getSnapshot().status).toBe('ready'); expect(other.controller.getSnapshot().status).toBe('idle');
    controller.dispose(); other.controller.dispose();
  });
  it('rejects malformed controllers before subscribing', () => {
    const forged = {} as ThreadCompactionController;
    function State() { useMayuraThreadCompactionCommand(forged); return null; }
    function Actions() { useMayuraThreadCompactionActions(forged); return null; }
    for (const view of [State, Actions]) expect(() => renderToString(createElement(view))).toThrowError(expect.objectContaining({ code: 'INVALID_COMPACTION_CONTROLLER' }));
  });
});

describe('thread compaction control', () => {
  it('reviews the captured command and is inert during SSR, StrictMode and unmount', async () => {
    const { controller, client } = fixture(); const node = createElement(MayuraThreadCompactionControl, { controller, subject: 'Order conversation' });
    expect(renderToString(node)).toContain('Summarize entries 1–3');
    await act(async () => { root.render(createElement(StrictMode, null, node)); });
    expect(element.textContent).toContain('Command: summary/one'); expect(button(0).getAttribute('aria-label')).toBe('Start compaction for Order conversation');
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
    await act(async () => { root.render(null); }); expect(controller.getSnapshot().status).toBe('idle'); controller.dispose();
  });
  it('starts once, keeps focus, renders released text safely and locks completed commands', async () => {
    const { controller, client } = fixture(); const pending = deferred<RemoteThreadCompactionResult>(); client.compactThread.mockImplementation(() => pending.promise);
    await act(async () => { root.render(createElement(MayuraThreadCompactionControl, { controller })); });
    button(0).focus(); await act(async () => { click(0); click(0); }); expect(client.compactThread).toHaveBeenCalledTimes(1);
    expect(dom.window.document.activeElement).toBe(button(0)); expect(button(0).getAttribute('aria-disabled')).toBe('true'); expect(button(2).getAttribute('aria-disabled')).toBe('false');
    await act(async () => { pending.resolve(receipt()); await pending.promise; });
    expect(element.querySelector('pre')?.textContent).toBe('<script>untrusted()</script>'); expect(element.querySelector('script')).toBeNull();
    expect(element.textContent).toContain('Original conversation entries are retained'); expect(element.textContent).toContain('Saved summary: entry 5');
    await act(async () => { click(0); click(2); }); expect(client.compactThread).toHaveBeenCalledTimes(1); expect(client.cancelThreadCompaction).not.toHaveBeenCalled(); controller.dispose();
  });
  it('requires inspection after uncertainty and publishes only a durably staged summary', async () => {
    const { controller, client } = fixture(); client.compactThread.mockRejectedValueOnce(new ClientError('CONVERSATION_UNAVAILABLE'));
    client.threadCompaction.mockResolvedValueOnce(progress('pending')).mockResolvedValueOnce(progress('ready'));
    await act(async () => { root.render(createElement(MayuraThreadCompactionControl, { controller })); });
    await act(async () => { click(0); });
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Inspect the same command');
    await act(async () => { click(0); }); expect(client.compactThread).toHaveBeenCalledTimes(1);
    await act(async () => { click(1); }); expect(button(0).getAttribute('aria-disabled')).toBe('true');
    await act(async () => { click(1); }); expect(button(0).textContent).toBe('Publish saved summary');
    await act(async () => { click(0); click(0); }); expect(client.compactThread).toHaveBeenCalledTimes(2); expect(controller.getSnapshot().result).not.toBeNull(); controller.dispose();
  });
  it('cancels during submission and ignores late submit feedback without disposing the controller', async () => {
    const { controller, client } = fixture(); const pending = deferred<RemoteThreadCompactionResult>(); client.compactThread.mockImplementation(() => pending.promise);
    await act(async () => { root.render(createElement(MayuraThreadCompactionControl, { controller })); });
    await act(async () => { click(0); }); await act(async () => { click(2); click(2); });
    expect(client.cancelThreadCompaction).toHaveBeenCalledTimes(1); expect(element.textContent).toContain('late summary publication is blocked');
    await act(async () => { pending.resolve(receipt()); await pending.promise; }); expect(element.querySelector('pre')).toBeNull();
    expect(controller.getSnapshot().status).toBe('ready'); expect(button(0).getAttribute('aria-disabled')).toBe('true'); controller.dispose();
  });
  it('does not present a missing reservation as successful cancellation or authorize a replacement call', async () => {
    const { controller, client } = fixture(); client.compactThread.mockRejectedValueOnce(new ClientError('REQUEST_TIMEOUT'));
    client.cancelThreadCompaction.mockResolvedValue({ status: 'missing' });
    await act(async () => { root.render(createElement(MayuraThreadCompactionControl, { controller })); });
    await act(async () => { click(0); }); await act(async () => { click(2); });
    expect(element.textContent).toContain('in-flight request may still reserve'); expect(button(0).getAttribute('aria-disabled')).toBe('true');
    await act(async () => { click(0); }); expect(client.compactThread).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it('does not allow failed or inspected committed commands to start another model call', async () => {
    for (const status of ['failed', 'committed'] as const) {
      const { controller, client } = fixture(); client.threadCompaction.mockResolvedValue(progress(status)); await controller.refresh();
      await act(async () => { root.render(createElement(MayuraThreadCompactionControl, { controller })); });
      await act(async () => { click(0); click(2); }); expect(client.compactThread).not.toHaveBeenCalled(); expect(client.cancelThreadCompaction).not.toHaveBeenCalled();
      if (status === 'failed') expect(element.textContent).toContain('Recorded cost (micros)Unknown');
      await act(async () => { root.render(null); }); controller.dispose();
    }
  });
  it('bounds summary display without splitting a surrogate pair and marks truncation', async () => {
    const { controller, client } = fixture(); client.compactThread.mockResolvedValue(receipt('ab😀more')); await controller.compact();
    await act(async () => { root.render(createElement(MayuraThreadCompactionControl, { controller, maxSummaryChars: 3 })); });
    expect(element.querySelector('pre')?.textContent).toBe('ab'); expect(element.querySelector('[data-mayura-truncated]')).not.toBeNull(); controller.dispose();
  });
  it('rejects invalid presentation props and closes controls on caller disposal', async () => {
    const { controller, client } = fixture();
    for (const props of [{ label: '' }, { subject: '' }, { maxSummaryChars: 0 }, { maxSummaryChars: 65_537 }])
      expect(() => renderToString(createElement(MayuraThreadCompactionControl, { controller, ...props }))).toThrowError(expect.objectContaining({ code: 'INVALID_COMPONENT_PROPS' }));
    await act(async () => { root.render(createElement(MayuraThreadCompactionControl, { controller })); }); await act(async () => { controller.dispose(); });
    await act(async () => { click(0); click(1); click(2); }); for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
    expect(element.textContent).toContain('controller closed');
  });
});
