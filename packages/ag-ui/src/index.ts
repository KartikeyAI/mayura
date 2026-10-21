import { ClientError, createClient, type ClientJson, type ClientSchema, type MayuraClient, type RemoteApproval, type RemoteRun, type RemoteSession, type RemoteSnapshot } from '@mayura/client';
import { sha256Hex } from '@mayura/core/host';
import { AgUiFailure, boundedJson, identifier, object, fields, readInput, type AgUiEvent, type AgUiMessage, type AgUiRunInput } from './protocol.js';
import { interruptCodec, type InterruptBinding } from './interrupts.js';
import { frontendInternals, type AgUiFrontendTools } from './frontend-tools.js';
export { createAgUiFrontendTools, type AgUiFrontendTools, type AgUiFrontendToolsOptions, type AgUiFrontendToolOptions, type AgUiFrontendToolLimits, type AgUiFrontendOutboxView } from './frontend-tools.js';
export { createAgUiFrontendExecutor, type AgUiFrontendExecutor, type AgUiFrontendExecutorOptions, type AgUiFrontendHandlerContext, type AgUiFrontendExecution } from './frontend-executor.js';
import { stateReader, type AgUiStateSource, type StateStream } from './state.js';
export type { AgUiStateContext, AgUiStateSource, AgUiStateVersion } from './state.js';
import { messageId, pendingMessage, proposalId, runTurn, threadView, toolCallId, type ThreadView } from './messages.js';
export { AG_UI_PROTOCOL_VERSION, type AgUiContentPart, type AgUiEvent, type AgUiInterrupt, type AgUiMessage, type AgUiResume, type AgUiRunInput, type AgUiToolCall, type AgUiState, type AgUiStateMetadata, type AgUiStatePatchOperation, type AgUiFrontendTool, type AgUiFrontendContinuation, type AgUiFrontendDispatchMetadata } from './protocol.js';

export interface AgUiLimits {
  readonly maxStateBytes?: number; readonly maxStatePatchBytes?: number; readonly maxStatePatchOperations?: number;
  readonly maxStateReads?: number; readonly maxConcurrentStateReads?: number; readonly stateReadTimeoutMs?: number;
  readonly maxRequestBytes?: number; readonly maxMessages?: number; readonly maxThreadEntries?: number;
  readonly maxSnapshotBytes?: number; readonly maxEventBytes?: number; readonly maxStreamBytes?: number;
  readonly maxEvents?: number; readonly maxConcurrentStreams?: number; readonly durationMs?: number; readonly requestTimeoutMs?: number;
}
export interface AgUiAdapterOptions {
  /** The existing scoped Mayura server. This adapter never constructs runtimes or grants permissions. */
  readonly server: { fetch(request: Request): Promise<Response> };
  /** Exact externally visible HTTPS origin (HTTP is permitted only for loopback development). */
  readonly publicOrigin: string;
  /** Fixed route, default /ag-ui. Mount explicitly alongside the server's /v1 routes. */
  readonly path?: string;
  readonly agentId: string;
  readonly permissions: { readonly allow: readonly string[] };
  /** Exactly 32 random bytes from host secret storage, shared by all replicas and retained across restarts. */
  readonly interruptKey: Uint8Array;
  /** Trusted, synchronous and deterministic mapping of the newest user text to the agent's input schema. */
  readonly input: (message: Extract<AgUiMessage, { readonly role: 'user' }>) => ClientJson;
  /** Optional read-only, scoped state source. Requires an additional explicit ag-ui:state host grant. */
  readonly state?: AgUiStateSource;
  /** Host-registered browser tools. Shared store mode accepts claims/results on any replica. */
  readonly frontendTools?: AgUiFrontendTools;
  /** Explicit irreversible native batch release. Requires ag-ui:stream; batch guards still belong to the agent. */
  readonly streaming?: 'guarded';
  /** Project opaque thread image/PDF handles; never fetches media. Requires ag-ui:media. */
  readonly media?: boolean;
  readonly limits?: AgUiLimits;
}
export interface AgUiAdapter {
  /** POST RunAgentInput, returning AG-UI 1.0 SSE. Commands are never automatically retried. */
  fetch(request: Request): Promise<Response>;
  /** Stop adapter observers only. The caller owns the underlying server and its durable runs. */
  close(): void;
}
const encoder = new TextEncoder();
const wireHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function failure(error: unknown): AgUiFailure {
  if (error instanceof AgUiFailure) return error;
  if (error instanceof ClientError) {
    // Only native sanitized codes; never return exception text, response bodies or provider diagnostics.
    if (error.status && [401, 403, 404, 409, 413, 429].includes(error.status)) return new AgUiFailure(`NATIVE_${error.status}`, error.status);
    if (error.code === 'ABORTED') return new AgUiFailure('ABORTED', 408);
    if (error.code === 'TIMEOUT') return new AgUiFailure('TIMEOUT', 408);
  }
  return new AgUiFailure('UPSTREAM_UNAVAILABLE', 503);
}
function errorEvent(error: unknown): AgUiEvent {
  return { type: 'RUN_ERROR', code: failure(error).code, message: 'Run observation could not continue. Inspect the native run before taking another action.' };
}
/** Race host work and body reads against the bounded observer lifetime; never wait on an ignored signal. */
async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); throw new AgUiFailure('ABORTED', 408); }
  let abort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new AgUiFailure('ABORTED', 408)); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
async function bodyJson(request: Request, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new AgUiFailure('CONTENT_TYPE', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)) throw new AgUiFailure('REQUEST_LIMIT', 413);
  if (!request.body) throw new AgUiFailure('INVALID_INPUT');
  const reader = request.body.getReader(); let complete = false; let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await withSignal(reader.read(), signal); if (next.done) { complete = true; break; }
      size += next.value.byteLength; if (size > maxBytes) throw new AgUiFailure('REQUEST_LIMIT', 413); chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new AgUiFailure('INVALID_JSON'); }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function resolveLimits(input: AgUiLimits = {}) {
  const defaults = { maxStateBytes: 262_144, maxStatePatchBytes: 65_536, maxStatePatchOperations: 128,
    maxStateReads: 1000, maxConcurrentStateReads: 32, stateReadTimeoutMs: 5000, maxRequestBytes: 262_144, maxMessages: 256, maxThreadEntries: 2_000, maxSnapshotBytes: 1_048_576,
    maxEventBytes: 1_100_000, maxStreamBytes: 8_388_608, maxEvents: 10_000, maxConcurrentStreams: 32, durationMs: 300_000, requestTimeoutMs: 30_000 };
  const result = { ...defaults, ...input };
  if (Object.keys(input).some(key => !(key in defaults)) || Object.values(result).some(value => !Number.isSafeInteger(value) || value < 1 || value > 16_777_216)
    || result.maxEventBytes < 1024 || result.maxStreamBytes < result.maxEventBytes + 1024 || result.maxEvents < 2
    || result.maxConcurrentStateReads > 1024 || result.maxStatePatchOperations > 4096
    || result.maxConcurrentStreams > 1024 || result.maxMessages > 4096 || result.maxThreadEntries > 10_000 || result.durationMs > 3_600_000) {
    throw new AgUiFailure('INVALID_LIMITS');
  }
  return Object.freeze(result);
}
const successfulOutput: ClientSchema<ClientJson> = { '~standard': { version: 1, validate: value => ({ value: value as ClientJson }) } };

/**
 * Scoped Fetch adapter over the existing authenticated API. Native run records own idempotency, budgets, exact-once
 * thread recording and checkpoint claims. Neither a browser transcript nor a resume token can mint native authority.
 */
export function createAgUiAdapter(options: AgUiAdapterOptions): AgUiAdapter {
  if (!options.permissions?.allow?.includes('ag-ui:serve')) throw new AgUiFailure('PERMISSION_DENIED', 403);
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || origin.username || origin.password
    || !['https:', 'http:'].includes(origin.protocol)
    || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new AgUiFailure('INVALID_ORIGIN');
  const path = options.path ?? '/ag-ui'; const agentId = identifier(options.agentId);
  if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.startsWith('/v1/') || typeof options.input !== 'function' || typeof options.server?.fetch !== 'function') throw new AgUiFailure('INVALID_CONFIG');
  if (options.state !== undefined && !options.permissions.allow.includes('ag-ui:state')) throw new AgUiFailure('PERMISSION_DENIED', 403);
  if (options.streaming !== undefined && (options.streaming !== 'guarded' || !options.permissions.allow.includes('ag-ui:stream'))) throw new AgUiFailure('PERMISSION_DENIED', 403);
  if (options.media !== undefined && typeof options.media !== 'boolean') throw new AgUiFailure('INVALID_CONFIG');
  if (options.media && !options.permissions.allow.includes('ag-ui:media')) throw new AgUiFailure('PERMISSION_DENIED', 403);
  const streamText = options.streaming === 'guarded'; const mediaEnabled = options.media === true;
  const limits = resolveLimits(options.limits);
  if (options.state !== undefined && (limits.maxStateBytes + 512 > limits.maxEventBytes || limits.maxStatePatchBytes + 512 > limits.maxEventBytes)) throw new AgUiFailure('INVALID_STATE_LIMITS');
  if (options.frontendTools !== undefined && (!options.permissions.allow.includes('ag-ui:frontend-tools') || options.frontendTools.agentId !== agentId)) throw new AgUiFailure('PERMISSION_DENIED', 403);
  const frontend = options.frontendTools === undefined ? undefined : frontendInternals(options.frontendTools);
  const claimPath = `${path}/frontend-tools/claim`;
  const readState = options.state === undefined ? undefined : stateReader(options.state, limits);
  const codec = interruptCodec(options.interruptKey, origin.origin, agentId);
  const nativeFetch = options.server.fetch.bind(options.server); const mapInput = options.input;
  let closed = false; const observers = new Set<(error?: AgUiFailure) => void>();
  const load = (client: MayuraClient, threadId: string, signal: AbortSignal) => threadView(client, threadId, limits.maxThreadEntries, limits.maxSnapshotBytes, signal, mediaEnabled);

  async function* events(client: MayuraClient, run: RemoteRun, input: AgUiRunInput, session: RemoteSession, signal: AbortSignal,
    initial: ThreadView, resumed?: { readonly binding: InterruptBinding; readonly approval: RemoteApproval }, frontendResume?: { readonly callId: string; readonly toolId: string; readonly input: ClientJson; readonly turnId: string }): AsyncGenerator<AgUiEvent> {
    yield { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId, metadata: { mayura: { runId: run.id } } };
    const originalPending: AgUiMessage | undefined = resumed ? pendingMessage(resumed.binding.turnId, resumed.approval) : frontendResume ? {
      id: proposalId(frontendResume.turnId, frontendResume.callId), role: 'assistant', toolCalls: [{ id: toolCallId(frontendResume.turnId, frontendResume.callId), type: 'function',
        function: { name: frontendResume.toolId, arguments: JSON.stringify(frontendResume.input) } }],
    } : undefined;
    const messages = [...initial.messages];
    if (originalPending && !messages.some(item => item.id === originalPending.id)) messages.push(originalPending);
    yield { type: 'MESSAGES_SNAPSHOT', messages };
    const streamed = new Map<number, { id: string; index: number; open: boolean }>();
    const openSteps = new Set<string>(); let consumed = 0; let after = resumed?.binding.after ?? 0; let current = await run.inspect({ signal });
    // A terminal run need not have retained every old event. Its authoritative result/history still suffice.
    if (current.status === 'running' || current.status === 'waiting') {
      for await (const event of run.events({ after, reconnect: false, signal })) {
        if (++consumed > limits.maxEvents) throw new AgUiFailure('NATIVE_EVENT_LIMIT', 413);
        after = event.sequence;
        if (event.type === 'events.gap') throw new AgUiFailure('EVENT_GAP', 409);
        if (event.type === 'history.applied') yield { type: 'CUSTOM', name: 'mayura.history.applied', value: boundedJson(event.metadata, 4096) };
        if (streamText && (event.type === 'output.delta' || event.type === 'output.withheld')) {
          const call = event.metadata['modelCall'];
          if (typeof call !== 'number' || !Number.isSafeInteger(call) || call < 0) throw new AgUiFailure('INVALID_NATIVE_EVENT', 503);
          let message = streamed.get(call);
          if (event.type === 'output.withheld') {
            if (message?.open) { message.open = false; yield { type: 'TEXT_MESSAGE_END', messageId: message.id }; }
            yield { type: 'CUSTOM', name: 'mayura.output.withheld', value: { modelCall: call } };
          } else {
            if (!message) { message = { id: `s-${sha256Hex(JSON.stringify([run.id, call]))}`, index: 0, open: true }; streamed.set(call, message);
              yield { type: 'TEXT_MESSAGE_START', messageId: message.id, role: 'assistant' }; }
            if (!message.open || event.metadata['index'] !== message.index++ || typeof event.metadata['text'] !== 'string') throw new AgUiFailure('INVALID_NATIVE_EVENT', 503);
            yield { type: 'TEXT_MESSAGE_CONTENT', messageId: message.id, delta: event.metadata['text'] };
          }
        }
        // Step events are segment-local. An interrupted step remains unfinished rather than claiming completion.
        if (event.type === 'step.started' || event.type === 'step.completed') {
          const step = event.metadata['step'];
          if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0) throw new AgUiFailure('INVALID_NATIVE_EVENT', 503);
          const stepName = `step.${step}`;
          if (event.type === 'step.started') { openSteps.add(stepName); yield { type: 'STEP_STARTED', stepName }; }
          else if (openSteps.delete(stepName)) yield { type: 'STEP_FINISHED', stepName };
          // A resumed segment may see completion of a step begun before the interrupt. Do not invent its start.
        }
        if (event.type === 'approval.requested' || event.type === 'run.paused' || event.type === 'run.completed') {
          current = await run.inspect({ signal });
          if (current.status === 'waiting' && current.approval) {
            for (const item of streamed.values()) if (item.open) { item.open = false; yield { type: 'TEXT_MESSAGE_END', messageId: item.id }; }
            // Old replayed approval events must not be mistaken for the current pending tool call.
            if (event.type === 'approval.requested' && (event.metadata['callId'] !== current.approval.callId || event.metadata['digest'] !== current.approval.digest)) continue;
            const view = await load(client, input.threadId, signal); const turnId = runTurn(view, run.id);
            yield* interrupt(run, input, session, current.approval, view, turnId, after, signal);
            return;
          }
          if (current.status !== 'waiting' && current.status !== 'running') break;
        }
      }
      current = await run.inspect({ signal });
    }
    for (const item of streamed.values()) if (item.open) { item.open = false; yield { type: 'TEXT_MESSAGE_END', messageId: item.id }; }
    if (current.status === 'waiting' && current.approval) {
      const view = await load(client, input.threadId, signal);
      yield* interrupt(run, input, session, current.approval, view, runTurn(view, run.id), after, signal); return;
    }
    if (current.status === 'running' || current.status === 'waiting') throw new AgUiFailure('STREAM_ENDED', 503);
    const outcome = await run.result(successfulOutput, { signal });
    if (!outcome) throw new AgUiFailure('RESULT_UNAVAILABLE', 503);
    const view = await load(client, input.threadId, signal); const turnId = runTurn(view, run.id);
    if (!view.entries.some(entry => entry.kind === 'run' && entry.runId === run.id && entry.status === outcome.status)) {
      throw new AgUiFailure('THREAD_RECORDING_INCOMPLETE', 409);
    }
    // The native recorder contains only released tool results. A resumed tool result references its original call.
    if (resumed || frontendResume) for (const entry of view.entries) {
      if (entry.turnId === turnId && entry.kind === 'tool_result' && entry.callId === (resumed?.binding.callId ?? frontendResume?.callId)
        && !initial.messages.some(message => message.id === messageId(input.threadId, entry.sequence))) {
        yield { type: 'TOOL_CALL_RESULT', messageId: messageId(input.threadId, entry.sequence), toolCallId: toolCallId(turnId, entry.callId),
          role: 'tool', content: typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result) };
      }
    }
    // Do not forward provisional native output.delta frames: a later output guard can withhold the final answer.
    if (outcome.status === 'succeeded') {
      const answer = view.entries.findLast(entry => entry.turnId === turnId && entry.kind === 'assistant');
      if (streamed.size === 0 && answer?.kind === 'assistant' && !initial.messages.some(item => item.id === messageId(input.threadId, answer.sequence))) {
        const id = messageId(input.threadId, answer.sequence); const content = typeof answer.output === 'string' ? answer.output : JSON.stringify(answer.output);
        yield { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' };
        if (content) yield { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: content };
        yield { type: 'TEXT_MESSAGE_END', messageId: id };
      }
    }
    yield { type: 'MESSAGES_SNAPSHOT', messages: view.messages };
    if (outcome.status === 'succeeded' || outcome.status === 'cancelled') {
      yield { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId, outcome: { type: outcome.status === 'succeeded' ? 'success' : 'cancelled' } };
    } else throw new AgUiFailure(`RUN_${outcome.status.toUpperCase()}`, 409);
  }
  async function* interrupt(run: RemoteRun, input: AgUiRunInput, session: RemoteSession, approval: RemoteApproval,
    view: ThreadView, turnId: string, after: number, signal: AbortSignal): AsyncGenerator<AgUiEvent> {
    if (signal.aborted || approval.expiresAtMs <= Date.now()) throw new AgUiFailure('INTERRUPT_EXPIRED', 409);
    const binding: InterruptBinding = { nativeRunId: run.id, externalRunId: input.runId, threadId: input.threadId, turnId,
      callId: approval.callId, digest: approval.digest, expiresAtMs: approval.expiresAtMs, after };
    const id = await withSignal(codec.seal(binding, session), signal); const callId = toolCallId(turnId, approval.callId);
    yield { type: 'TEXT_MESSAGE_START', messageId: proposalId(turnId, approval.callId), role: 'assistant' };
    yield { type: 'TOOL_CALL_START', toolCallId: callId, toolCallName: approval.toolId, parentMessageId: proposalId(turnId, approval.callId) };
    yield { type: 'TOOL_CALL_ARGS', toolCallId: callId, delta: JSON.stringify(approval.input) };
    yield { type: 'TOOL_CALL_END', toolCallId: callId };
    yield { type: 'TEXT_MESSAGE_END', messageId: proposalId(turnId, approval.callId) };
    yield { type: 'MESSAGES_SNAPSHOT', messages: [...view.messages.filter(item => item.id !== proposalId(turnId, approval.callId)), pendingMessage(turnId, approval)] };
    yield { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId, outcome: { type: 'interrupt', interrupts: [{ id, reason: 'tool_call', toolCallId: callId,
      message: 'This tool call requires approval.', expiresAt: new Date(approval.expiresAtMs).toISOString(),
      responseSchema: { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'], additionalProperties: false } }] } };
  }

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      let release: ((error?: AgUiFailure) => void) | undefined;
      try {
        if (closed) throw new AgUiFailure('ADAPTER_CLOSED', 503);
        const url = new URL(request.url);
        if (url.origin !== origin.origin || (url.pathname !== path && !(frontend && url.pathname === claimPath)) || url.search) throw new AgUiFailure('NOT_FOUND', 404);
        if (request.method !== 'POST') throw new AgUiFailure('METHOD_NOT_ALLOWED', 405);
        // Same-origin browser profile. Explicit Bearer credentials are still required; cookies are never forwarded.
        const browserOrigin = request.headers.get('origin');
        if (browserOrigin !== null && browserOrigin !== origin.origin) throw new AgUiFailure('ORIGIN_DENIED', 403);
        if (request.headers.get('sec-fetch-site') === 'cross-site') throw new AgUiFailure('ORIGIN_DENIED', 403);
        if (observers.size >= limits.maxConcurrentStreams) throw new AgUiFailure('STREAM_LIMIT', 429);
        const credential = request.headers.get('authorization');
        if (!credential || !/^Bearer [\x21-\x7e]{1,8192}$/.test(credential)) throw new AgUiFailure('UNAUTHENTICATED', 401);
        const aborter = new AbortController(); let ended = false; let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
        let iterator: AsyncGenerator<AgUiEvent> | undefined;
        const onAbort = () => stop();
        const stop = (error?: AgUiFailure): void => {
          if (ended) return; ended = true; clearTimeout(timer); observers.delete(stop);
          request.signal.removeEventListener('abort', onAbort); aborter.abort();
          if (sink) {
            try { if (error) sink.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent(error))}\n\n`)); sink.close(); }
            catch { /* The reader may have cancelled already. */ }
          }
          void iterator?.return(undefined).catch(() => {});
        };
        const timer = setTimeout(() => stop(new AgUiFailure('DURATION_LIMIT', 408)), limits.durationMs);
        release = stop; observers.add(stop); request.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal.aborted) stop();
        const signal = aborter.signal;
        const client = createClient({ baseUrl: origin.origin, token: () => credential.slice(7), requestTimeoutMs: limits.requestTimeoutMs,
          maxResponseBytes: Math.min(16_777_216, Math.max(limits.maxSnapshotBytes, limits.maxRequestBytes, 262_144)), maxReconnectAttempts: 0,
          fetch: async (target, init) => {
            const forwarded = new Request(target, init); const headers = new Headers(forwarded.headers);
            if (browserOrigin !== null) headers.set('Origin', browserOrigin);
            const site = request.headers.get('sec-fetch-site'); if (site !== null) headers.set('Sec-Fetch-Site', site);
            return nativeFetch(new Request(forwarded, { headers }));
          } });
        // Authenticate before consuming untrusted bodies; native policies remain responsible for every resource access.
        const session = await client.session({ signal });
        const requiredCapabilities = ['runs:read', 'threads:read'] as const;
        if (!session.agentIds.includes(agentId) || requiredCapabilities.some(capability => !session.capabilities.includes(capability))) throw new AgUiFailure('PERMISSION_DENIED', 403);
        if (!['threads', 'runRecords'].every(feature => session.features.includes(feature as 'threads' | 'runRecords'))) throw new AgUiFailure('SERVER_FEATURE_REQUIRED', 503);
        if (url.pathname === claimPath) {
          const command = object(boundedJson(await bodyJson(request, limits.maxRequestBytes, signal), 1024)); fields(command, ['token']);
          if (typeof command['token'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(command['token'])) throw new AgUiFailure('INVALID_FRONTEND_CONTINUATION');
          const target = await frontend!.inspect(command['token'], session.scope, signal);
          const thread = await client.thread(target.threadId, { signal }); const run = await client.run(target.nativeRunId).inspect({ signal });
          if (thread.status !== 'active' || thread.agentId !== agentId || (run.status !== 'running' && !(run.status === 'waiting' && run.toolWait?.callId === target.callId))) throw new AgUiFailure('FRONTEND_CALL_UNAVAILABLE', 409);
          const view = await load(client, target.threadId, signal); const turnId = runTurn(view, target.nativeRunId);
          const claim = { ...await frontend!.claim(command['token'], session.scope, signal), toolCallId: toolCallId(turnId, target.callId) };
          release?.(); return new Response(JSON.stringify(claim), { headers: { ...wireHeaders, 'Content-Type': 'application/json' } });
        }
        const input = readInput(await bodyJson(request, limits.maxRequestBytes, signal), limits.maxRequestBytes, limits.maxMessages, readState !== undefined, frontend !== undefined, mediaEnabled);
        await frontend?.advertise(input.tools ?? [], session.scope, signal);
        let frontendResume: { callId: string; toolId: string; input: ClientJson; turnId: string } | undefined;
        let run: RemoteRun; let resumed: { binding: InterruptBinding; approval: RemoteApproval } | undefined;
        const resume = input.resume?.[0];
        let initial: ThreadView; let state: StateStream | undefined;
        const prepareState = () => readState?.({ scope: session.scope, agentId, threadId: input.threadId, runId: input.runId, signal },
          async () => {
            const thread = await client.thread(input.threadId, { signal });
            if (thread.status !== 'active' || thread.agentId !== agentId) throw new AgUiFailure('THREAD_AGENT_MISMATCH', 409);
          });
        const wakeTool = async (targetRun: RemoteRun, expectedCallId?: string): Promise<void> => {
          const current = await targetRun.inspect({ signal }); const wait = current.toolWait;
          if (!wait || (expectedCallId !== undefined && wait.callId !== expectedCallId)) return;
          if (!session.capabilities.includes('runs:resume') || !session.features.includes('toolContinuations')) throw new AgUiFailure('PERMISSION_DENIED', 403);
          try { await targetRun.resumeTool({ callId: wait.callId, digest: wait.digest }, { signal }); }
          catch (error) {
            // A racing owner may already have consumed the checkpoint. Observe that run; never resubmit paid work.
            if (!(error instanceof ClientError) || error.status !== 409) throw error;
            const next = await targetRun.inspect({ signal });
            if (next.toolWait?.digest === wait.digest) throw new AgUiFailure('FRONTEND_RECOVERY_CONFLICT', 409);
          }
        };
        const frontendContinuation = input.forwardedProps?.mayuraFrontend;
        if (frontendContinuation) {
          const target = await frontend!.inspect(frontendContinuation.token, session.scope, signal, true);
          if (target.threadId !== input.threadId) throw new AgUiFailure('FRONTEND_BINDING_CONFLICT', 409);
          initial = await load(client, input.threadId, signal); const turnId = runTurn(initial, target.nativeRunId);
          run = client.run(target.nativeRunId); await run.inspect({ signal }); state = await prepareState();
          await frontend!.result(frontendContinuation.token, frontendContinuation.claimId, session.scope, input.threadId, input.runId,
            input.messages[0]!, toolCallId(turnId, target.callId), signal);
          await wakeTool(run, target.callId);
          frontendResume = { callId: target.callId, toolId: target.toolId, input: target.input, turnId };
        } else if (resume) {
          if (!session.capabilities.includes('runs:approve') || !session.features.includes('runApprovals')) throw new AgUiFailure('PERMISSION_DENIED', 403);
          const binding = await withSignal(codec.open(resume.interruptId, session), signal);
          if (binding.threadId !== input.threadId || binding.externalRunId === input.runId) throw new AgUiFailure('INVALID_RESUME_LINK', 409);
          initial = await load(client, input.threadId, signal);
          if (runTurn(initial, binding.nativeRunId) !== binding.turnId) throw new AgUiFailure('RUN_THREAD_MISMATCH', 409);
          run = client.run(binding.nativeRunId); const current: RemoteSnapshot = await run.inspect({ signal }); const approval = current.approval;
          if (current.status !== 'waiting' || !approval || approval.callId !== binding.callId || approval.digest !== binding.digest
            || approval.expiresAtMs !== binding.expiresAtMs || approval.expiresAtMs <= Date.now()) throw new AgUiFailure('APPROVAL_CONFLICT', 409);
          state = await prepareState();
          resumed = { binding, approval };
          // Exactly one native claim attempt. Uncertain replies and already-claimed approvals are never replayed.
          await run.approve({ callId: binding.callId, digest: binding.digest, decision: resume.status === 'resolved' && resume.payload.approved ? 'approved' : 'rejected' }, { signal });
          await frontend?.bind(session.scope, run.id, input.threadId, input.tools ?? [], signal);
        } else {
          if (!session.capabilities.includes('runs:submit') || !session.capabilities.includes('threads:write')) throw new AgUiFailure('PERMISSION_DENIED', 403);
          let thread;
          try { thread = await client.thread(input.threadId, { signal }); }
          catch (error) {
            if (!(error instanceof ClientError) || error.status !== 404) throw error;
            thread = await client.createThread({ id: input.threadId, agentId }, { signal });
          }
          if (thread.status !== 'active' || thread.agentId !== agentId) throw new AgUiFailure('THREAD_AGENT_MISMATCH', 409);
          initial = await load(client, input.threadId, signal);
          state = await prepareState();
          const user = input.messages.at(-1) as Extract<AgUiMessage, { readonly role: 'user' }>;
          const nativeInput = boundedJson(mapInput(user), limits.maxRequestBytes);
          run = await client.submit(agentId, nativeInput, { threadId: input.threadId, signal,
            idempotencyKey: `agui-${sha256Hex(JSON.stringify([agentId, input.threadId, input.runId]))}` });
          await frontend?.bind(session.scope, run.id, input.threadId, input.tools ?? [], signal);
          await wakeTool(run);
          // begin() records the association asynchronously before model work. Do not require its marker in the
          // submission reply race; interrupt/terminal projection verifies it once that work has been admitted.
        }
        iterator = events(client, run, input, session, signal, initial, resumed, frontendResume);
        let bytes = 0; let count = 0; let pending: Promise<IteratorResult<AgUiEvent>> | undefined;
        // Hold at most one native event behind its state update. No producer queue grows with a slow reader.
        let queued: IteratorYieldResult<AgUiEvent> | 'heartbeat' | undefined;
        const frontendFrames: AgUiEvent[] = []; let frontendToken: string | undefined; let heartbeatAt = Date.now(); let stateChecked = false;
        let started = false; let initialStatePending = state !== undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { sink = controller; if (ended) controller.close(); },
          async pull(controller) {
            if (ended) return;
            let beat: ReturnType<typeof setTimeout> | undefined;
            try {
              let event: AgUiEvent | undefined;
              if (started && initialStatePending) {
                initialStatePending = false; event = state!.initial();
              } else {
                if (queued === undefined && frontendFrames.length) queued = { done: false, value: frontendFrames.shift()! };
                if (queued === undefined) {
                  if (!pending) { pending = iterator!.next(); void pending.catch(() => {}); }
                  let next: IteratorResult<AgUiEvent> | 'heartbeat' | undefined;
                  while (true) {
                    const tick = await Promise.race([pending, new Promise<'poll'>(resolve => { beat = setTimeout(resolve, frontend ? 100 : 15_000, 'poll'); })]);
                    clearTimeout(beat); if (ended) return;
                    if (tick !== 'poll') { next = tick; break; }
                    if (frontend && await frontend.pending(session.scope, run.id, signal)) {
                      const view = await load(client, input.threadId, signal); const turnId = runTurn(view, run.id);
                      await run.inspect({ signal }); const dispatch = await frontend.dispatch(session.scope, run.id, input.threadId, input.runId, signal);
                      if (dispatch) {
                        frontendToken = dispatch.token;
                        const id = toolCallId(turnId, dispatch.callId); const parent = proposalId(turnId, dispatch.callId);
                        frontendFrames.push(
                          { type: 'TEXT_MESSAGE_START', messageId: parent, role: 'assistant' },
                          { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: dispatch.toolId, parentMessageId: parent,
                            metadata: { mayura: { frontend: { token: dispatch.token, expiresAtMs: dispatch.expiresAtMs, claimPath } } } },
                          { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(dispatch.input) }, { type: 'TOOL_CALL_END', toolCallId: id },
                          { type: 'TEXT_MESSAGE_END', messageId: parent },
                          { type: 'MESSAGES_SNAPSHOT', messages: [...view.messages, { id: parent, role: 'assistant', toolCalls: [{ id, type: 'function', function: { name: dispatch.toolId, arguments: JSON.stringify(dispatch.input) } }] }] },
                          { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId, outcome: { type: 'success', pendingToolCallIds: [id] } },
                        );
                        break;
                      }
                    }
                    if (Date.now() - heartbeatAt >= 15_000) { heartbeatAt = Date.now(); next = 'heartbeat'; break; }
                  }
                  if (frontendFrames.length) next = { done: false, value: frontendFrames.shift()! };
                  else if (next !== 'heartbeat') {
                    if (!next) throw new AgUiFailure('FRONTEND_UNAVAILABLE', 409);
                    pending = undefined; if (next.done) { stop(); return; }
                  }
                  queued = next as IteratorYieldResult<AgUiEvent> | 'heartbeat'; stateChecked = false;
                }
                if (state && started && !stateChecked) { event = await state.refresh(); stateChecked = true; }
                if (!event) { event = queued === 'heartbeat' ? undefined : queued.value; queued = undefined; stateChecked = false; }
              }
              // Recheck disclosure after every wait, including host callbacks and buffered state/message frames.
              await run.inspect({ signal }); await client.thread(input.threadId, { signal });
              if (event?.type === 'STATE_SNAPSHOT' || event?.type === 'STATE_DELTA') await state!.authorize();
              if (frontendToken) await frontend!.disclose(frontendToken, session.scope, signal);
              if (ended) return;
              const frame = event === undefined ? encoder.encode(': keep-alive\n\n')
                : encoder.encode(`data: ${JSON.stringify({ ...event, timestamp: Date.now() })}\n\n`);
              // Reserve one small terminal error frame for limits/timeouts, even under backpressure.
              if (frame.byteLength > limits.maxEventBytes || bytes + frame.byteLength > limits.maxStreamBytes - 1024 || count >= limits.maxEvents - 1) throw new AgUiFailure('STREAM_OUTPUT_LIMIT', 413);
              bytes += frame.byteLength; count++; controller.enqueue(frame);
              if (event?.type === 'RUN_STARTED') started = true;
              if (event?.type === 'RUN_FINISHED' || event?.type === 'RUN_ERROR') stop();
            } catch (error) { if (!ended) stop(failure(error)); }
            finally { clearTimeout(beat); }
          },
          cancel() { stop(); },
        }, { highWaterMark: 0 });
        return new Response(stream, { headers: { ...wireHeaders, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no', 'X-Mayura-Run-Id': run.id } });
      } catch (error) {
        release?.(); const safe = failure(error);
        return new Response(JSON.stringify({ error: { code: safe.code, message: 'The AG-UI request could not be completed.' } }),
          { status: safe.status, headers: { ...wireHeaders, 'Content-Type': 'application/json', ...(safe.status === 405 ? { Allow: 'POST' } : {}) } });
      }
    },
    close(): void { closed = true; for (const stop of [...observers]) stop(new AgUiFailure('ADAPTER_CLOSED', 503)); },
  });
}
