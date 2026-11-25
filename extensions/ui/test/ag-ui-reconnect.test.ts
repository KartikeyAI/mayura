import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  useAgUiConversation, type AgUiConversation, type AgUiEvent, type AgUiRunObservation, type AgUiTransport,
} from '../src/ag-ui.js';

const binding = { threadId: 'saved-thread', runId: 'a9cbb9f4-5dd6-4d59-9fa8-50aa9c672018' };
const prompt = { id: 'prompt', role: 'user', content: 'Show the rollout status.' } as const;
const reply = { id: 'reply', role: 'assistant', content: 'The rollout is ready.' } as const;
const snapshot = (...messages: readonly [typeof prompt, ...(typeof reply)[]]): AgUiEvent => ({
  type: 'MESSAGES_SNAPSHOT', messages,
});
const start = (target: AgUiRunObservation): AgUiEvent => ({
  type: 'RUN_STARTED', ...target, metadata: { mayura: { runId: binding.runId } },
});
const success = (target: AgUiRunObservation): AgUiEvent => ({
  type: 'RUN_FINISHED', ...target, outcome: { type: 'success' },
});
const encode = (...events: readonly AgUiEvent[]): string => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const wire = (...events: readonly AgUiEvent[]): Response => new Response(encode(...events), {
  headers: { 'content-type': 'text/event-stream', 'x-mayura-run-id': binding.runId },
});
const transcript = () => [prompt, reply];

let dom: JSDOM;
let root: Root;
let chat: AgUiConversation;

beforeEach(() => {
  dom = new JSDOM('<main></main>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.querySelector('main')!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

async function mount(transport: AgUiTransport) {
  function Probe() {
    chat = useAgUiConversation({ transport });
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
}

it('reattaches after reload using the active run on the authorized thread', async () => {
  const run = vi.fn<AgUiTransport['run']>();
  const readThread = vi.fn(async () => ({ busy: true, activeRunId: binding.runId, messages: [prompt] }));
  const observeRun = vi.fn(async () => wire(start(binding), snapshot(prompt), snapshot(prompt, reply), success(binding)));
  await mount({ run, readThread, observeRun });
  expect(observeRun).not.toHaveBeenCalled();
  await act(async () => { expect(await chat.openThread(binding.threadId)).toBe(true); });
  expect(readThread).toHaveBeenCalledWith(binding.threadId, expect.any(AbortSignal));
  expect(observeRun).toHaveBeenCalledExactlyOnceWith(binding, expect.any(AbortSignal));
  expect(run).not.toHaveBeenCalled();
  expect(chat.status).toBe('complete');
  expect(chat.messages.map(message => message.content)).toEqual(transcript().map(message => message.content));
});

it.each(['header and metadata', 'only metadata'] as const)('reconstructs the same submitted run once after disconnection using %s', async identitySource => {
  let identity = binding;
  const run = vi.fn<AgUiTransport['run']>(async input => {
    identity = { threadId: input.threadId, runId: binding.runId };
    const response = wire(start(input), snapshot(prompt),
      { type: 'TEXT_MESSAGE_START', messageId: 'live', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'live', delta: 'The rollout' });
    if (identitySource === 'only metadata') response.headers.delete('x-mayura-run-id');
    return response;
  });
  const observeRun = vi.fn(async () => wire(start(identity),
    { type: 'STATE_SNAPSHOT', snapshot: { replyCards: [] }, metadata: { mayura: { stateRevision: 0 } } },
    snapshot(prompt),
    { type: 'TEXT_MESSAGE_START', messageId: 'live', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'live', delta: reply.content },
    { type: 'TEXT_MESSAGE_END', messageId: 'live' },
    snapshot(prompt, reply), success(identity)));
  await mount({ run, observeRun });
  await act(async () => { expect(chat.send(prompt.content)).toBe(true); });
  expect(run).toHaveBeenCalledTimes(1);
  expect(observeRun).toHaveBeenCalledExactlyOnceWith(identity, expect.any(AbortSignal));
  expect(chat.status).toBe('complete');
  expect(chat.messages.map(message => message.id)).toEqual(['prompt', 'reply']);
  expect(chat.messages.map(message => message.content)).toEqual(transcript().map(message => message.content));
});

it('rejects an identity conflict between the native header and start metadata', async () => {
  const run = vi.fn<AgUiTransport['run']>(async input => {
    const response = wire(start(input), snapshot(prompt, reply));
    response.headers.set('x-mayura-run-id', '3a847d06-73d3-4046-90c2-d632603a4e88');
    return response;
  });
  const observeRun = vi.fn<NonNullable<AgUiTransport['observeRun']>>();
  await mount({ run, observeRun });
  await act(async () => { expect(chat.send(prompt.content)).toBe(true); });
  expect(run).toHaveBeenCalledTimes(1);
  expect(observeRun).not.toHaveBeenCalled();
  expect(chat.status).toBe('error');
  expect(chat.messages.map(message => message.content)).toEqual([prompt.content]);
});

it('rejects a mismatched observation and requires an explicit reconnect after it fails', async () => {
  const run = vi.fn<AgUiTransport['run']>();
  const readThread = async () => ({ busy: true, activeRunId: binding.runId, messages: [prompt] });
  const observeRun = vi.fn<NonNullable<AgUiTransport['observeRun']>>()
    .mockImplementationOnce(async () => wire(start({ ...binding, threadId: 'another-thread' }), snapshot(prompt, reply)))
    .mockImplementationOnce(async () => wire(start(binding), snapshot(prompt), snapshot(prompt, reply), success(binding)));
  await mount({ run, readThread, observeRun });
  await act(async () => { await chat.openThread(binding.threadId); });
  expect(observeRun).toHaveBeenCalledTimes(1);
  expect(chat.status).toBe('error');
  expect(chat.connection).toBe('disconnected');
  expect(chat.messages.map(message => message.id)).toEqual(['prompt']);
  await act(async () => { expect(await chat.reconnect?.()).toBe(true); });
  expect(observeRun).toHaveBeenCalledTimes(2);
  expect(run).not.toHaveBeenCalled();
  expect(chat.status).toBe('complete');
});

it.each(['NATIVE_403', 'AUTH_EXPIRED'])('clears the transcript after %s on an open stream and stops reconnecting', async code => {
  const run = vi.fn<AgUiTransport['run']>();
  const readThread = async () => ({ busy: true, activeRunId: binding.runId, messages: [prompt] });
  const observeRun = vi.fn(async () => wire(start(binding), snapshot(prompt, reply),
    { type: 'RUN_ERROR', code, message: 'Access denied.' }));
  await mount({ run, readThread, observeRun });
  await act(async () => { await chat.openThread(binding.threadId); });
  expect(chat.status).toBe('error');
  expect(chat.threadId).toBeNull();
  expect(chat.messages).toEqual([]);
  expect(chat.interruption).toBeNull();
  expect(await chat.reconnect?.()).toBe(false);
  expect(observeRun).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
});

it('keeps the settled transcript when the observed run reports an uncertain terminal outcome', async () => {
  const run = vi.fn<AgUiTransport['run']>();
  const readThread = async () => ({ busy: true, activeRunId: binding.runId, messages: [prompt] });
  const observeRun = vi.fn(async () => wire(start(binding), snapshot(prompt), snapshot(prompt, reply),
    { type: 'RUN_ERROR', code: 'RUN_OUTCOME_UNKNOWN', message: 'The outcome is uncertain.' }));
  await mount({ run, readThread, observeRun });
  await act(async () => { await chat.openThread(binding.threadId); });
  expect(chat.status).toBe('error');
  expect(chat.connection).toBeUndefined();
  expect(chat.messages.at(-1)?.content).toBe(reply.content);
  expect(chat.send('Start it again')).toBe(false);
  expect(await chat.reconnect?.()).toBe(false);
  expect(observeRun).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
});

it('withholds the same proposal after an uncertain decision even when its opaque handle rotates', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const interruption = { id: 'initial-handle', toolCallId: 'save', message: 'Save the checklist',
    toolName: 'save_checklist', arguments: '{}', expiresAt };
  const readThread = async () => ({ messages: [prompt], interruption });
  const run = vi.fn<AgUiTransport['run']>(async input => wire(start(input), snapshot(prompt)));
  const observeRun = vi.fn(async () => wire(start(binding), snapshot(prompt),
    { type: 'TOOL_CALL_START', toolCallId: 'save', toolCallName: 'save_checklist', parentMessageId: prompt.id },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'save', delta: '{}' },
    { type: 'TOOL_CALL_END', toolCallId: 'save' },
    snapshot(prompt),
    { type: 'RUN_FINISHED', ...binding, outcome: { type: 'interrupt', interrupts: [{
      ...interruption, id: 'rotated-handle', reason: 'tool_call', responseSchema: {},
    }] } }));
  await mount({ run, readThread, observeRun });
  await act(async () => { await chat.openThread(binding.threadId); });
  expect(chat.interruption?.id).toBe('initial-handle');
  await act(async () => chat.decide(true));
  expect(chat.status).toBe('error');
  expect(chat.connection).toBe('disconnected');
  expect(chat.interruption).toBeNull();
  await act(async () => chat.decide(true));
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].resume?.[0]?.interruptId).toBe('initial-handle');
  expect(observeRun).toHaveBeenCalledTimes(1);
});

it('detaches an observer on reset without cancelling the run', async () => {
  const run = vi.fn<AgUiTransport['run']>();
  const cancel = vi.fn<NonNullable<AgUiTransport['cancel']>>();
  const readThread = async () => ({ busy: true, activeRunId: binding.runId, messages: [prompt] });
  const onCancel = vi.fn();
  const observeRun = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(encode(start(binding), snapshot(prompt)))); },
    cancel: onCancel,
  }), { headers: { 'content-type': 'text/event-stream' } }));
  await mount({ run, cancel, readThread, observeRun });
  await act(async () => { await chat.openThread(binding.threadId); });
  expect(chat.status).toBe('streaming');
  await act(async () => chat.reset());
  expect(chat.status).toBe('idle');
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
