import { JSDOM } from 'jsdom';
import { act, createElement, type ReactElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { AgentWorkspace } from '../src/agent-workspace.js';
import { type AgUiEvent, type AgUiTransport } from '../src/ag-ui.js';

async function withWorkspace(app: ReactElement, check: (container: Element) => Promise<void>) {
  const dom = new JSDOM('<div id="root">' + renderToString(app) + '</div>', { pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const container = dom.window.document.querySelector('#root')!;
  const errors: unknown[] = [];
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, app, { onRecoverableError: error => errors.push(error) });
    });
    await check(container);
    expect(errors).toEqual([]);
  } finally {
    if (root) await act(async () => root?.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  }
}

it('restores the active thread through read-only AG-UI and opens its cited source on a narrow screen', async () => {
  const threadId = 'saved-thread';
  const runId = 'a9cbb9f4-5dd6-4d59-9fa8-50aa9c672018';
  const binding = { threadId, runId };
  const question = { id: 'question', role: 'user', content: 'When do we rotate the key?' } as const;
  const answer = { id: 'answer', role: 'assistant', content: 'Rotate the key after expiry [1].' } as const;
  const exactExcerpt = 'Rotate expired keys at the next scheduled maintenance window.';
  const events: readonly AgUiEvent[] = [
    { type: 'RUN_STARTED', ...binding, metadata: { mayura: { runId } } },
    { type: 'STATE_SNAPSHOT', snapshot: {
      citations: [{ id: '1', title: 'Rotation runbook', detail: 'Key rotation', excerpt: exactExcerpt }],
      replyCards: [{ id: 'ownership', type: 'table', title: 'Owners', data: { columns: ['Team'], rows: [['Platform']] } }],
    }, metadata: { mayura: { stateRevision: 0 } } },
    { type: 'MESSAGES_SNAPSHOT', messages: [question] },
    { type: 'MESSAGES_SNAPSHOT', messages: [question, answer] },
    { type: 'RUN_FINISHED', ...binding, outcome: { type: 'success' } },
  ];
  const run = vi.fn<AgUiTransport['run']>();
  const observeRun = vi.fn<NonNullable<AgUiTransport['observeRun']>>(async () => new Response(
    events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  ));
  const onThreadChange = vi.fn();
  const app = createElement(AgentWorkspace, {
    transport: { run, readThread: async () => ({ busy: true, activeRunId: runId, messages: [question] }), observeRun },
    initialThreadId: threadId,
    onThreadChange,
  });
  expect(run).not.toHaveBeenCalled();
  expect(observeRun).not.toHaveBeenCalled();
  await withWorkspace(app, async container => {
    expect(run).not.toHaveBeenCalled();
    expect(observeRun).toHaveBeenCalledExactlyOnceWith(binding, expect.any(AbortSignal));
    expect(onThreadChange).toHaveBeenCalledExactlyOnceWith(threadId);
    expect(container.querySelector('table')?.textContent).toContain('Platform');

    const citation = container.querySelector<HTMLButtonElement>('button[aria-label="Open source: Rotation runbook"]');
    expect(citation).toBeTruthy();
    await act(async () => citation?.click());
    expect(container.querySelector('dialog[open] blockquote')?.textContent).toBe(exactExcerpt);
  });
});

it('opens a held approval as a review without observing or resubmitting its run', async () => {
  const run = vi.fn<AgUiTransport['run']>();
  const observeRun = vi.fn<NonNullable<AgUiTransport['observeRun']>>();
  const argumentsJson = '{"title":"Checklist","destination":"/docs","content":"Check latency"}';
  const readThread = vi.fn(async () => ({
    messages: [{ id: 'prompt-1', role: 'user', content: 'Save the checklist' }],
    busy: true,
    activeRunId: 'previous-run',
    interruption: {
      id: 'approval-1', toolCallId: 'tool-1', toolName: 'save-checklist', arguments: argumentsJson,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), message: 'Review the proposed checklist.',
    },
  }));
  const app = createElement(AgentWorkspace, {
    transport: { run, observeRun, readThread },
    initialThreadId: 'saved-thread',
    reviewChange: () => ({ title: 'Checklist', destination: '/docs', content: 'Check latency' }),
  });
  await withWorkspace(app, async container => {
    expect(readThread).toHaveBeenCalledExactlyOnceWith('saved-thread', expect.any(AbortSignal));
    expect(observeRun).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Exact tool input"]')?.textContent).toBe(argumentsJson);
    expect(container.querySelector('[aria-label="Added document lines"]')?.textContent).toContain('Check latency');
    expect(container.querySelector('textarea')?.closest('[hidden]')).toBeTruthy();
    expect(container.querySelector('textarea')?.disabled).toBe(true);
  });
});

it('keeps the local follow-up draft while a dropped stream reattaches', async () => {
  const runId = 'a9cbb9f4-5dd6-4d59-9fa8-50aa9c672018';
  const suggestion = 'Show the rollout.';
  const encoder = new TextEncoder();
  const frames = (...events: readonly AgUiEvent[]) => encoder.encode(
    events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
  );
  const headers = { 'content-type': 'text/event-stream', 'x-mayura-run-id': runId };
  let original!: ReadableStreamDefaultController<Uint8Array>;
  let observer!: ReadableStreamDefaultController<Uint8Array>;
  const run = vi.fn<AgUiTransport['run']>(async input => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      original = controller;
      controller.enqueue(frames({ type: 'RUN_STARTED', runId: input.runId, threadId: input.threadId, metadata: { mayura: { runId } } }));
    },
  }), { headers }));
  const observeRun = vi.fn<NonNullable<AgUiTransport['observeRun']>>(async () =>
    new Response(new ReadableStream<Uint8Array>({ start(controller) { observer = controller; } }), { headers }));
  await withWorkspace(createElement(AgentWorkspace, { transport: { run, observeRun }, suggestions: [suggestion] }), async container => {
    const startingPrompt = [...container.querySelectorAll('button')].find(button => button.textContent === suggestion);
    expect(startingPrompt).toBeTruthy();
    await act(async () => startingPrompt?.click());
    const input = container.querySelector('textarea')!;
    const followUp = container.querySelector<HTMLButtonElement>('[aria-label="Draft a follow-up"] button')!;
    expect(followUp).toBeTruthy();
    const draft = followUp.textContent!;
    const focus = vi.spyOn(input, 'focus').mockImplementation(() => {});
    try { await act(async () => followUp.click()); } finally { focus.mockRestore(); }
    expect(input.value).toBe(draft);

    await act(async () => original.close());
    const submitted = run.mock.calls[0]![0];
    const binding = { threadId: submitted.threadId, runId };
    expect(observeRun).toHaveBeenCalledExactlyOnceWith(binding, expect.any(AbortSignal));
    expect(input.closest('[hidden]')).toBeTruthy();
    expect(input.disabled).toBe(true);

    const user = submitted.messages[0]!;
    await act(async () => {
      observer.enqueue(frames(
        { type: 'RUN_STARTED', ...binding, metadata: { mayura: { runId } } },
        { type: 'MESSAGES_SNAPSHOT', messages: [user] },
        { type: 'MESSAGES_SNAPSHOT', messages: [user, { id: 'settled', role: 'assistant', content: 'Ready.' }] },
        { type: 'RUN_FINISHED', ...binding, outcome: { type: 'success' } },
      ));
      observer.close();
    });
    expect(container.querySelector('textarea')).toBe(input);
    expect(input.closest('[hidden]')).toBeNull();
    expect(input.value).toBe(draft);
    expect(input.disabled).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

it('clears an unavailable restored thread from the host when the user starts a new chat', async () => {
  const onThreadChange = vi.fn();
  const app = createElement(AgentWorkspace, {
    transport: { run: vi.fn(), readThread: async () => { throw new Error('Missing thread'); } },
    initialThreadId: 'missing-thread',
    onThreadChange,
  });
  await withWorkspace(app, async container => {
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('couldn’t be opened');
    expect(onThreadChange).not.toHaveBeenCalled();
    const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open conversation navigation"]');
    expect(open).toBeTruthy();
    await act(async () => open?.click());
    const start = [...container.querySelectorAll('dialog button')].find(button => button.textContent === 'New chat') as HTMLButtonElement | undefined;
    expect(start).toBeTruthy();
    await act(async () => start?.click());
    expect(onThreadChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
