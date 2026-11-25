'use client';

import { useEffect, useRef, useState } from 'react';
import { AG_UI_PROTOCOL_VERSION, type AgUiEvent, type AgUiRunInput } from './ag-ui-protocol.js';
import { readArtifacts, type ReplyArtifact } from './artifacts.js';
import { maxPromptLength } from './draft-context.js';
import type { RunActivityItem } from './run-activity.js';
import type { ThreadSummary } from './thread-history.js';

export {
  AG_UI_PROTOCOL_VERSION, type AgUiContentPart, type AgUiEvent, type AgUiFrontendContinuation,
  type AgUiFrontendDispatchMetadata, type AgUiFrontendTool, type AgUiInterrupt, type AgUiJson, type AgUiMessage,
  type AgUiResume, type AgUiRunInput, type AgUiState, type AgUiStateMetadata, type AgUiStatePatchOperation,
  type AgUiToolCall,
} from './ag-ui-protocol.js';
export { maxPromptLength } from './draft-context.js';

export interface ConversationMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly retryable?: boolean;
}

export interface Citation {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly excerpt: string;
}

export interface ApprovalInterrupt {
  readonly id: string;
  readonly toolCallId: string;
  readonly message: string;
  readonly toolName: string;
  readonly arguments: string;
  readonly expiresAt: string;
}

export type AgUiConversationStatus = 'idle' | 'streaming' | 'paused' | 'complete' | 'error' | 'stopped';

export interface ActivityTrace {
  readonly id: string;
  readonly items: readonly RunActivityItem[];
}

interface ReplyState {
  readonly citations: readonly Citation[];
  readonly artifacts: readonly ReplyArtifact[];
}

export interface ConversationState extends ReplyState {
  readonly threadId: string | null;
  readonly status: AgUiConversationStatus;
  readonly messages: readonly ConversationMessage[];
  readonly interruption: ApprovalInterrupt | null;
  readonly activity: ActivityTrace | null;
  readonly error: string | null;
}

export interface AgUiThreadList {
  readonly threads: readonly ThreadSummary[];
}

export interface AgUiThreadView {
  readonly messages: readonly ConversationMessage[];
  readonly citations?: readonly Citation[];
  readonly artifacts?: readonly ReplyArtifact[];
  readonly interruption?: ApprovalInterrupt | null;
  readonly pendingPrompt?: ConversationMessage & { readonly role: 'user' };
  readonly busy?: boolean;
}

/** The host owns endpoints, credentials, cancellation and thread authorization. Do not retry run or approval requests. */
export interface AgUiTransport {
  run(input: AgUiRunInput, signal: AbortSignal): Promise<Response>;
  cancel?(nativeRunId: string, signal: AbortSignal): Promise<boolean>;
  listThreads?(signal: AbortSignal): Promise<unknown>;
  readThread?(id: string, signal: AbortSignal): Promise<unknown>;
}

export interface AgUiApprovalOptions {
  /** Check that this proposal can be accurately presented for review. Does not authorize the write. */
  readonly validate?: (interruption: ApprovalInterrupt) => boolean;
  readonly toolLabel?: (toolName: string) => string;
  /** Interpret an explicitly observed result from a resolved approval. */
  readonly resultStatus?: (details: { readonly toolName: string; readonly approved: boolean; readonly content: string }) =>
    RunActivityItem['status'];
}

export interface AgUiConversationOptions {
  readonly transport: AgUiTransport;
  /** Exact same-origin paths the host allows artifacts to load. */
  readonly mediaPaths?: readonly string[];
  readonly approval?: AgUiApprovalOptions;
  /** Optionally unwrap structured text in stored snapshots. Streamed deltas already contain display text. */
  readonly projectStoredAnswer?: (content: string) => string;
}

interface RequestState {
  readonly controller: AbortController;
  readonly transport: AgUiTransport;
  nativeRunId?: string;
}

interface ApprovalDecision {
  readonly id: string;
  readonly approved: boolean;
  readonly toolCallId: string;
  readonly toolName: string;
}

const initial: ConversationState = {
  threadId: null, status: 'idle', messages: [], citations: [], artifacts: [], interruption: null, activity: null, error: null,
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const threadIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

const maxText = 65_536;
const maxStreamBytes = 8_388_608;
const maxFrameChars = 524_288;

function closeOpenActivity(activity: ActivityTrace | null, status: 'paused' | 'stopped' | 'unconfirmed'): ActivityTrace | null {
  if (!activity) return null;
  // A paused segment can end without STEP_FINISHED. Preserve that interruption in the timeline.
  return { ...activity, items: activity.items.map(item => item.status === 'running'
    || (status !== 'paused' && item.kind === 'tool' && item.status === 'paused') ? { ...item, status } : item) };
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a JSON object.');
  return input as Record<string, unknown>;
}

function text(input: unknown, limit = maxText): string {
  if (typeof input !== 'string' || input.length > limit) throw new Error('Invalid text in an AG-UI event.');
  return input;
}

function toolResultStatus(content: string, decision: ApprovalDecision, approval?: AgUiApprovalOptions): RunActivityItem['status'] {
  const status = approval?.resultStatus?.({ toolName: decision.toolName, approved: decision.approved, content });
  return status === 'complete' || status === 'declined' || status === 'failed' ? status : 'unconfirmed';
}

function readCitations(input: unknown): readonly Citation[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 24) throw new Error('Invalid citation state.');
  const ids = new Set<string>();
  return input.map(item => {
    const source = record(item);
    const id = text(source['id'], 64);
    if (!id || ids.has(id)) throw new Error('Duplicate citation ID.');
    ids.add(id);
    return {
      id, title: text(source['title'], 200), detail: text(source['detail'], 250), excerpt: text(source['excerpt'], 2_000),
    };
  });
}

async function observe(response: Response, onEvent: (event: AgUiEvent) => void, signal: AbortSignal): Promise<void> {
  if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream') {
    await response.body?.cancel().catch(() => {});
    throw new Error('The AG-UI endpoint did not return an event stream.');
  }

  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let tail = '';
  let data: string[] = [];
  let frameSize = 0;
  const onLine = (raw: string) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) {
      if (data.length) {
        const value = record(JSON.parse(data.join('\n')) as unknown);
        text(value['type'], 64);
        onEvent(value as unknown as AgUiEvent);
      }
      data = [];
      frameSize = 0;
      return;
    }
    frameSize += line.length + 1;
    if (frameSize > maxFrameChars) throw new Error('The AG-UI event is too large.');
    if (line.startsWith('data:')) {
      const value = line.slice(5);
      data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  };
  const onChunk = (chunk: string) => {
    const lines = chunk.split('\n');
    if (lines.length === 1) {
      tail += chunk;
    } else {
      onLine(tail + (lines[0] ?? ''));
      for (const line of lines.slice(1, -1)) onLine(line);
      tail = lines.at(-1) ?? '';
    }
    if (tail.length + frameSize > maxFrameChars) throw new Error('The AG-UI event is too large.');
  };

  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxStreamBytes) throw new Error('The AG-UI stream is too large.');
      onChunk(decoder.decode(next.value, { stream: true }));
    }
    onChunk(decoder.decode());
    if (tail || frameSize || data.length) throw new Error('Incomplete AG-UI event.');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Terminal = Extract<AgUiEvent, { type: 'RUN_FINISHED' }>['outcome'];

function replyState(value: unknown, mediaPaths?: readonly string[]): ReplyState {
  const state = record(value);
  return { citations: readCitations(state['citations']), artifacts: readArtifacts(state['artifacts'], { mediaPaths }) };
}

/** Apply only the supported AG-UI reply state fields. */
function readReplyState(
  event: Extract<AgUiEvent, { type: 'STATE_SNAPSHOT' | 'STATE_DELTA' }>,
  revision: number | undefined,
  current: ReplyState,
  mediaPaths?: readonly string[],
): { revision: number; state: ReplyState } {
  const cursor = record(record(event.metadata)['mayura']);
  const nextRevision = cursor['stateRevision'];
  if (typeof nextRevision !== 'number' || !Number.isSafeInteger(nextRevision) || nextRevision < 0
    || (revision !== undefined && nextRevision <= revision)) {
    throw new Error('Invalid reply state revision.');
  }
  if (event.type === 'STATE_SNAPSHOT') {
    return { revision: nextRevision, state: replyState(event.snapshot, mediaPaths) };
  }
  if (revision === undefined || cursor['previousStateRevision'] !== revision
    || !Array.isArray(event.delta) || event.delta.length > 128) {
    throw new Error('Reply state needs a new snapshot.');
  }

  let { citations, artifacts } = current;
  for (const operation of event.delta) {
    if (operation.path === '/citations') {
      citations = operation.op === 'remove' ? [] : readCitations(operation.value);
    } else if (operation.path === '/artifacts') {
      artifacts = operation.op === 'remove' ? [] : readArtifacts(operation.value, { mediaPaths });
    } else if (operation.path === '' && operation.op === 'replace') {
      ({ citations, artifacts } = replyState(operation.value, mediaPaths));
    }
  }
  return { revision: nextRevision, state: { citations, artifacts } };
}

function snapshotMessages(value: unknown, projectStoredAnswer?: (content: string) => string): readonly ConversationMessage[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('Invalid message snapshot.');
  const messages: ConversationMessage[] = [];
  let startOfTurn = 0;
  let sawUser = false;
  let sawTool = false;
  const finishTurn = () => {
    if (!sawTool) return;
    for (let index = startOfTurn; index < messages.length; index++) {
      const message = messages[index];
      if (message?.role === 'assistant') messages[index] = { ...message, retryable: false };
    }
  };
  for (const raw of value) {
    const message = record(raw);
    const role = message['role'];
    if (role === 'user') {
      finishTurn();
      startOfTurn = messages.length;
      sawUser = true;
      sawTool = false;
    }
    if (role === 'tool' || (role === 'assistant' && Array.isArray(message['toolCalls']) && message['toolCalls'].length > 0)) sawTool = true;
    if ((role !== 'user' && role !== 'assistant') || typeof message['content'] !== 'string') continue;
    const content = text(message['content']);
    const display = role === 'assistant' && projectStoredAnswer ? text(projectStoredAnswer(content)) : content;
    messages.push({ id: text(message['id'], 128), role, content: display,
      ...(role === 'assistant' ? { retryable: sawUser && message['retryable'] !== false } : {}) });
  }
  finishTurn();
  return messages;
}

/** Read and validate the listing supplied by the caller's history integration. */
export async function listThreadHistory(transport: AgUiTransport, signal: AbortSignal): Promise<readonly ThreadSummary[]> {
  if (!transport.listThreads) return [];
  const { threads } = record(await transport.listThreads(signal));
  signal.throwIfAborted();
  if (!Array.isArray(threads) || threads.length > 100) throw new Error('Invalid thread listing.');
  const ids = new Set<string>();
  return threads.map(raw => {
    const { id, title, updatedAt, pendingApproval } = record(raw);
    const date = text(updatedAt, 64);
    if (typeof id !== 'string' || !threadIdPattern.test(id) || ids.has(id)
      || typeof pendingApproval !== 'boolean' || !Number.isFinite(Date.parse(date))) throw new Error('Invalid thread summary.');
    ids.add(id);
    return { id, title: text(title, 300), updatedAt: date, pendingApproval };
  });
}

function readInterruption(raw: unknown, approval?: AgUiApprovalOptions): ApprovalInterrupt {
  const proposal = record(raw);
  const interruption: ApprovalInterrupt = Object.freeze({
    id: text(proposal['id'], 4_096), toolCallId: text(proposal['toolCallId'], 128),
    toolName: text(proposal['toolName'], 128), arguments: text(proposal['arguments']),
    message: text(proposal['message'], 512), expiresAt: text(proposal['expiresAt'], 64),
  });
  if (!interruption.id || !interruption.toolCallId || !interruption.toolName
    || !Number.isFinite(Date.parse(interruption.expiresAt))
    || (approval?.validate && approval.validate(interruption) !== true)) {
    throw new Error('Invalid approval proposal.');
  }
  return interruption;
}

async function cancelRun(request: RequestState): Promise<boolean> {
  if (!request.transport.cancel || !request.nativeRunId) return false;
  try {
    const signal = AbortSignal.timeout(5_000);
    const cancelled = await request.transport.cancel(request.nativeRunId, signal);
    return !signal.aborted && cancelled === true;
  } catch {
    return false;
  }
}

export interface AgUiConversation extends ConversationState {
  readonly openingThreadId: string | null;
  readonly historyError: string | null;
  openThread(id: string): Promise<boolean>;
  clearHistoryError(): void;
  send(content: string): boolean;
  retry(replyId: string): boolean;
  decide(approved: boolean): void;
  stop(): void;
  reset(): void;
}

/** Mayura AG-UI conversation controller. Each send or approval makes one call to the supplied transport. */
export function useAgUiConversation({ transport, mediaPaths, approval, projectStoredAnswer }: AgUiConversationOptions): AgUiConversation {
  const [state, setState] = useState<ConversationState>(initial);
  const [openingThreadId, setOpeningThreadId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const current = useRef(state);
  const thread = useRef<string | null>(null);
  const active = useRef<RequestState | null>(null);
  const opening = useRef<AbortController | null>(null);
  const pendingPrompt = useRef<ConversationMessage | undefined>(undefined);
  const publish = (value: ConversationState) => {
    current.current = value;
    setState(value);
  };

  useEffect(() => () => {
    active.current?.controller.abort();
    active.current = null;
    opening.current?.abort();
    opening.current = null;
  }, []);

  async function openThread(id: string): Promise<boolean> {
    if (active.current || !transport.readThread || !threadIdPattern.test(id)) return false;
    opening.current?.abort();
    const controller = new AbortController();
    opening.current = controller;
    setHistoryError(null);
    setOpeningThreadId(id);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      const data = record(await transport.readThread(id, signal));
      signal.throwIfAborted();
      if (opening.current !== controller) return false;
      const messages = snapshotMessages(data['messages'], projectStoredAnswer);
      const reply = replyState(data, mediaPaths);
      const interrupted = data['interruption'];
      const interruption = interrupted == null ? null : readInterruption(interrupted, approval);
      const [pending] = data['pendingPrompt'] === undefined ? [] : snapshotMessages([data['pendingPrompt']]);
      if (pending && (pending.role !== 'user' || !interruption)) throw new Error('Invalid pending prompt.');
      const prompt = pending ?? messages.findLast(message => message.role === 'user');
      if (interruption && !prompt) throw new Error('Pending approval has no prompt.');
      const activity: ActivityTrace | null = interruption && prompt ? {
        id: prompt.id, items: [{ id: 'tool:' + interruption.toolCallId, kind: 'tool', status: 'paused',
          label: displayToolName(interruption.toolName) }],
      } : null;
      const busy = data['busy'] === true && !interruption;
      thread.current = id;
      pendingPrompt.current = pending && !messages.some(message => message.id === pending.id) ? pending : undefined;
      publish({ ...reply, threadId: id, status: interruption ? 'paused' : busy ? 'error' : 'complete',
        messages: pendingPrompt.current ? [...messages, pendingPrompt.current] : messages, interruption, activity,
        error: busy ? 'This thread has an active run. Open it again to check its status.' : null });
      return true;
    } catch {
      if (opening.current === controller) setHistoryError('This thread couldn’t be opened. Try again.');
      return false;
    } finally {
      if (opening.current === controller) {
        opening.current = null;
        setOpeningThreadId(null);
      }
    }
  }

  function displayToolName(toolName: string): string {
    return text(approval?.toolLabel?.(toolName) ?? toolName, 200);
  }

  async function run(user?: ConversationMessage, decision?: ApprovalDecision) {
    if (active.current || opening.current) return;
    const request: RequestState = { controller: new AbortController(), transport };
    active.current = request;
    thread.current ??= crypto.randomUUID();
    if (user) pendingPrompt.current = user;
    const input: AgUiRunInput = {
      protocolVersion: AG_UI_PROTOCOL_VERSION, threadId: thread.current, runId: crypto.randomUUID(),
      messages: user ? [user] : [],
      ...(decision ? { resume: [{ interruptId: decision.id, status: 'resolved', payload: { approved: decision.approved } }] } : {}),
    };

    let view: ConversationState = {
      ...current.current, threadId: input.threadId, status: 'streaming', interruption: null, error: null,
      ...(user ? { messages: [...current.current.messages, user], activity: { id: user.id, items: [] } } : {}),
    };
    publish(view);
    const update = (patch: Partial<ConversationState>) => {
      if (active.current !== request) return;
      view = { ...view, ...patch };
      publish(view);
    };
    const appendActivity = (item: RunActivityItem) => {
      const trace = view.activity;
      if (!trace || trace.items.length >= 64 || trace.items.some(entry => entry.id === item.id)) {
        throw new Error('Unexpected AG-UI activity.');
      }
      update({ activity: { ...trace, items: [...trace.items, item] } });
    };
    const finishActivity = (id: string, status: RunActivityItem['status']) => {
      const trace = view.activity;
      if (!trace?.items.some(item => item.id === id)) throw new Error('AG-UI activity not found.');
      update({ activity: { ...trace, items: trace.items.map(item => item.id === id ? { ...item, status } : item) } });
    };

    let openingSnapshot = true;
    let settledMessages: readonly ConversationMessage[] | undefined;
    // A snapshot can precede persistence of the current turn, so retain the optimistic prompt until the snapshot contains it.
    const withPending = (messages: readonly ConversationMessage[]) => {
      const prompt = pendingPrompt.current;
      return prompt && !messages.some(message => message.id === prompt.id) ? [...messages, prompt] : messages;
    };
    let revision: number | undefined;
    let terminal: Terminal | undefined;
    let started = false;
    const liveMessages = new Map<string, string>();
    const proposals = new Map<string, { name: string; args: string; ended: boolean }>();
    const openSteps = new Map<string, string>();
    let receivedDecisionResult = false;
    try {
      const signal = AbortSignal.any([request.controller.signal, AbortSignal.timeout(90_000)]);
      const response = await request.transport.run(input, signal);
      const nativeId = response.headers.get('x-mayura-run-id');
      if (nativeId && uuid.test(nativeId)) request.nativeRunId = nativeId;

      await observe(response, event => {
        if (active.current !== request) return;
        if (terminal) throw new Error('AG-UI event after completion.');
        switch (event.type) {
          case 'RUN_STARTED':
            if (started || event.runId !== input.runId || event.threadId !== input.threadId) throw new Error('Unexpected AG-UI run.');
            started = true;
            return;
          case 'MESSAGES_SNAPSHOT': {
            const messages = snapshotMessages(event.messages, projectStoredAnswer);
            if (openingSnapshot) {
              update({ messages: withPending(messages) });
              openingSnapshot = false;
            } else settledMessages = messages;
            return;
          }
          case 'STATE_SNAPSHOT':
          case 'STATE_DELTA': {
            const next = readReplyState(event, revision, view, mediaPaths);
            revision = next.revision;
            update(next.state);
            return;
          }
          case 'STEP_STARTED': {
            const name = text(event.stepName, 128);
            const id = input.runId + ':step:' + name;
            const index = /^step\.(\d+)$/u.exec(name)?.[1];
            appendActivity({ id, kind: 'step', label: index === undefined ? name : 'Step ' + (Number(index) + 1), status: 'running' });
            openSteps.set(name, id);
            return;
          }
          case 'STEP_FINISHED': {
            const id = openSteps.get(event.stepName);
            if (!id) throw new Error('AG-UI finished a step without a start.');
            openSteps.delete(event.stepName);
            finishActivity(id, 'complete');
            return;
          }
          case 'TEXT_MESSAGE_START': {
            const id = text(event.messageId, 128);
            if (liveMessages.has(id) || liveMessages.size >= 32) throw new Error('Unexpected AG-UI message start.');
            liveMessages.set(id, '');
            return;
          }
          case 'TEXT_MESSAGE_CONTENT': {
            const previous = liveMessages.get(event.messageId);
            if (previous === undefined) throw new Error('AG-UI content without a message start.');
            const content = text(previous + text(event.delta));
            liveMessages.set(event.messageId, content);
            const message = { id: event.messageId, role: 'assistant' as const, content };
            const messages = previous ? view.messages.map(item => item.id === message.id ? message : item) : [...view.messages, message];
            if (content) update({ messages });
            return;
          }
          case 'TEXT_MESSAGE_END':
            liveMessages.delete(event.messageId);
            return;
          case 'TOOL_CALL_START': {
            const id = text(event.toolCallId, 128);
            const name = text(event.toolCallName, 128);
            if (!id || !name || proposals.has(id) || proposals.size >= 32) throw new Error('Unexpected AG-UI tool proposal.');
            proposals.set(id, { name, args: '', ended: false });
            appendActivity({ id: 'tool:' + id, kind: 'tool', label: displayToolName(name), status: 'running' });
            return;
          }
          case 'TOOL_CALL_ARGS': {
            const proposal = proposals.get(event.toolCallId);
            if (!proposal || proposal.ended) throw new Error('Unexpected AG-UI tool arguments.');
            proposal.args = text(proposal.args + text(event.delta));
            return;
          }
          case 'TOOL_CALL_END': {
            const proposal = proposals.get(event.toolCallId);
            if (!proposal || proposal.ended) throw new Error('Unexpected AG-UI tool proposal end.');
            proposal.ended = true;
            return;
          }
          case 'TOOL_CALL_RESULT': {
            if (!decision || receivedDecisionResult || event.toolCallId !== decision.toolCallId || event.role !== 'tool') {
              throw new Error('Unexpected AG-UI tool result.');
            }
            finishActivity('tool:' + decision.toolCallId, toolResultStatus(text(event.content), decision, approval));
            receivedDecisionResult = true;
            return;
          }
          case 'RUN_FINISHED':
            if (!started || event.runId !== input.runId || event.threadId !== input.threadId) throw new Error('Unexpected AG-UI result.');
            terminal = event.outcome;
            return;
          case 'RUN_ERROR':
            throw new Error('AG-UI reported a run error.');
        }
      }, signal);
      if (active.current !== request) return;
      if (!terminal) throw new Error('The AG-UI stream ended before completion.');
      const result: Terminal = terminal;
      if (result.type === 'interrupt') {
        const interruption = result.interrupts?.[0];
        const proposal = interruption && proposals.get(interruption.toolCallId);
        if (result.interrupts.length !== 1 || !interruption || !proposal?.ended || interruption.reason !== 'tool_call') {
          throw new Error('Approval proposal was incomplete.');
        }
        const bound = readInterruption({ ...interruption, toolName: proposal.name, arguments: proposal.args }, approval);
        update({ status: 'paused', activity: closeOpenActivity(view.activity, 'paused'),
          ...(settledMessages ? { messages: withPending(settledMessages) } : {}), interruption: bound });
      } else if (result.type === 'success' && !result.pendingToolCallIds?.length) {
        if (decision && !receivedDecisionResult) throw new Error('Missing AG-UI tool result.');
        pendingPrompt.current = undefined;
        update({ status: 'complete', activity: closeOpenActivity(view.activity, 'unconfirmed'),
          ...(settledMessages ? { messages: settledMessages } : {}) });
      } else if (result.type === 'cancelled') {
        pendingPrompt.current = undefined;
        update({ status: 'stopped', activity: closeOpenActivity(view.activity, 'stopped'),
          ...(settledMessages ? { messages: settledMessages } : {}) });
      } else {
        throw new Error('This AG-UI controller does not execute browser tools.');
      }
    } catch {
      update({ status: 'error', activity: closeOpenActivity(view.activity, 'unconfirmed'), error: decision
        ? 'The approval outcome could not be confirmed. Start a new conversation to continue.'
        : 'The conversation stream stopped unexpectedly. Start a new conversation to continue.' });
    } finally {
      if (active.current === request) active.current = null;
    }
  }

  function send(content: string): boolean {
    const prompt = content.trim();
    if (active.current || opening.current || !['idle', 'complete'].includes(current.current.status) || !prompt || prompt.length > maxPromptLength) return false;
    void run({ id: crypto.randomUUID(), role: 'user', content: prompt });
    return true;
  }

  return {
    ...state, openingThreadId, historyError, openThread, send,
    clearHistoryError(): void {
      setHistoryError(null);
    },
    retry(replyId: string): boolean {
      const { messages, status } = current.current;
      const reply = messages.at(-1);
      const prompt = messages.findLast(message => message.role === 'user');
      return status === 'complete' && reply?.id === replyId && reply.retryable === true && !!prompt && send(prompt.content);
    },
    decide(approved: boolean): void {
      const { status, interruption } = current.current;
      if (active.current || opening.current || status !== 'paused' || !interruption) return;
      if (Date.parse(interruption.expiresAt) <= Date.now()) {
        publish({ ...current.current, status: 'error', interruption: null, activity: closeOpenActivity(current.current.activity, 'unconfirmed'),
          error: 'The approval expired. Start a new conversation to continue.' });
        return;
      }
      void run(undefined, { id: interruption.id, toolCallId: interruption.toolCallId, toolName: interruption.toolName, approved });
    },
    stop(): void {
      const request = active.current;
      if (!request) return;
      active.current = null;
      request.controller.abort();
      publish({ ...current.current, status: 'stopped', interruption: null, error: null });
      const stoppedThread = thread.current;
      void cancelRun(request).then(confirmed => {
        if (thread.current !== stoppedThread || current.current.status !== 'stopped') return;
        publish({ ...current.current, activity: closeOpenActivity(current.current.activity, confirmed ? 'stopped' : 'unconfirmed'),
          ...(confirmed ? {} : { error: 'Observation stopped. The run cancellation could not be confirmed.' }) });
      });
    },
    reset(): void {
      const request = active.current;
      active.current = null;
      opening.current?.abort();
      opening.current = null;
      setOpeningThreadId(null);
      setHistoryError(null);
      request?.controller.abort();
      if (request) void cancelRun(request);
      thread.current = null;
      pendingPrompt.current = undefined;
      publish(initial);
    },
  };
}
