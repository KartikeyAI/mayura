import type { FrontendToolStore } from '@mayura/storage-contracts';
import { createDurableFrontendTools } from './durable-frontend-tools.js';
import { MayuraError, type Authorizer, type InferInput, type Schema, type Scope } from '@mayura/core';
import { defineTool, type ToolDefinition, type ToolOptions } from '@mayura/tools';
import { sha256Hex, toBase64Url, utf8ByteLength } from '@mayura/core/host';
import type { ClientJson } from '@mayura/client';
import { AgUiFailure, boundedJson, identifier, type AgUiFrontendTool, type AgUiMessage } from './protocol.js';

export interface AgUiFrontendToolLimits {
  readonly maxTools?: number; readonly maxRuns?: number; readonly maxCalls?: number; readonly maxPending?: number;
  readonly storageTimeoutMs?: number; readonly maxStorageOperations?: number; readonly pollIntervalMs?: number;
  readonly maxInputBytes?: number; readonly maxResultBytes?: number; readonly maxRunMs?: number; readonly retentionMs?: number;
}
export interface AgUiFrontendToolsOptions {
  readonly agentId: string; readonly permissions: { readonly allow: readonly string[] }; readonly authorization: Authorizer;
  /** Shared durable CAS journal. Omit only for an explicitly process-local bridge. */
  readonly store?: FrontendToolStore;
  /** Opt in to native continuation checkpoints before browser dispatch. Requires a shared store. */
  readonly nativeRecovery?: { readonly permissions: { readonly allow: readonly string[] } };
  readonly limits?: AgUiFrontendToolLimits;
}
export type AgUiFrontendToolOptions<I extends Schema, O extends Schema> = Omit<ToolOptions<I, O>, 'execute' | 'media' | 'costMicros' | 'timeoutMs'> & {
  /** Explicit reservation, including zero. Native broker charges its normal conservative settlement. */
  readonly costMicros: number; readonly timeoutMs: number;
};
export interface AgUiFrontendOutboxView {
  readonly waitState?: 'prepared' | 'parked';
  readonly nativeRunId: string; readonly callId: string; readonly toolId: string; readonly status: 'pending' | 'claimed' | 'settled';
  readonly expiresAtMs: number; readonly retainUntilMs: number; readonly resultDigest: string | null; readonly continuationRunId: string | null;
  readonly acceptedAtMs: number | null; readonly reservedAtMs: number | null; readonly delivery: 'pending' | 'reserved' | null; readonly purged: boolean;
}
export interface AgUiFrontendTools {
  readonly agentId: string;
  /** Install the returned native tool in the pinned agent; grant tool:<id>, frontend:<id> and its effect explicitly. */
  defineTool<I extends Schema, O extends Schema>(options: AgUiFrontendToolOptions<I, O>): ToolDefinition<I, O>;
  /** Metadata-only host recovery view; scoped frontend_result authorization is still required. */
  outboxes(input: { readonly scope: Scope; readonly runId: string; readonly signal?: AbortSignal }): Promise<readonly AgUiFrontendOutboxView[]>;
  /** Reject live waits; never dispatch or retry a browser action during shutdown. */
  close(): void;
}
interface Binding { readonly scope: Scope; readonly runId: string; readonly threadId: string; readonly tools: readonly string[]; readonly expiresAtMs: number }
interface Call {
  readonly token: string; readonly scope: Scope; readonly runId: string; readonly callId: string; readonly toolId: string;
  readonly input: ClientJson; readonly expiresAtMs: number; status: 'pending' | 'claimed' | 'settled' | 'cancelled';
  claimId?: string; dispatchedRunId?: string; resultDigest?: string; continuationRunId?: string; claimedThreadId?: string;
  resolve(value: unknown): void; reject(error: Error): void;
}
export interface FrontendDispatch {
  readonly token: string; readonly callId: string; readonly toolId: string; readonly input: ClientJson; readonly expiresAtMs: number;
}
export interface FrontendInternals {
  advertise(tools: readonly AgUiFrontendTool[], scope: Scope, signal: AbortSignal): Promise<void>;
  bind(scope: Scope, nativeRunId: string, threadId: string, tools: readonly AgUiFrontendTool[], signal?: AbortSignal): void | Promise<void>;
  pending(scope: Scope, runId: string, signal?: AbortSignal): boolean | Promise<boolean>;
  dispatch(scope: Scope, runId: string, threadId: string, externalRunId: string, signal: AbortSignal): Promise<FrontendDispatch | undefined>;
  disclose(token: string, scope: Scope, signal: AbortSignal): Promise<void>;
  inspect(token: string, scope: Scope, signal?: AbortSignal, forResult?: boolean): { readonly nativeRunId: string; readonly threadId: string; readonly callId: string; readonly toolId: string; readonly input: ClientJson } | Promise<{ readonly nativeRunId: string; readonly threadId: string; readonly callId: string; readonly toolId: string; readonly input: ClientJson }>;
  claim(token: string, scope: Scope, signal: AbortSignal): Promise<{ readonly name: string; readonly input: ClientJson; readonly claimId: string; readonly expiresAtMs: number }>;
  result(token: string, claimId: string, scope: Scope, threadId: string, runId: string, message: AgUiMessage, expectedToolCallId: string, signal: AbortSignal): Promise<string>;
}
const services = new WeakMap<AgUiFrontendTools, FrontendInternals>();
export function registerFrontendService(service: AgUiFrontendTools, internals: FrontendInternals): void { services.set(service, internals); }
export function frontendInternals(service: AgUiFrontendTools): FrontendInternals {
  const value = services.get(service); if (!value) throw new AgUiFailure('INVALID_FRONTEND_SERVICE'); return value;
}
const sameScope = (a: Scope, b: Scope) => a.principalId === b.principalId && a.projectId === b.projectId;
const owner = (scope: Scope, runId: string) => JSON.stringify([scope.principalId, scope.projectId, runId]);
const digest = (value: unknown): string => {
  const canonical = (item: any): string => item === null || typeof item !== 'object' ? JSON.stringify(item)
    : Array.isArray(item) ? `[${item.map(canonical).join(',')}]`
    : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
  return sha256Hex(canonical(value));
};
/**
 * Permissioned native/browser bridge. Supply a shared store for durable claims and result outboxes across replicas.
 * Without a store, serving requests require the same live instance. Neither mode replays uncertain browser writes.
 */
export function createAgUiFrontendTools(options: AgUiFrontendToolsOptions): AgUiFrontendTools {
  if (!options.permissions?.allow?.includes('ag-ui:frontend-tools') || typeof options.authorization?.require !== 'function') throw new AgUiFailure('PERMISSION_DENIED', 403);
  if (options.nativeRecovery && !options.store) throw new AgUiFailure('FRONTEND_STORE_REQUIRED', 400);
  if (options.store !== undefined) return createDurableFrontendTools(options);
  const agentId = identifier(options.agentId); const authorization = options.authorization;
  const limits = { maxTools: 32, maxRuns: 1024, maxCalls: 1024, maxPending: 128, maxInputBytes: 65_536, maxResultBytes: 65_536,
    maxRunMs: 300_000, retentionMs: 60_000, ...options.limits };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1 || value > 16_777_216)
    || limits.maxTools > 128 || limits.maxRuns > 10_000 || limits.maxCalls > 10_000 || limits.maxPending > limits.maxCalls || limits.maxRunMs > 3_600_000) throw new AgUiFailure('INVALID_FRONTEND_LIMITS');
  let closed = false; let pending = 0;
  const definitions = new Map<string, AgUiFrontendTool>(); const calls = new Map<string, Call>(); const bindings = new Map<string, Binding>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (work: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); work(); }, ms); timers.add(timer); return timer; };
  const check = (signal?: AbortSignal) => { if (closed || signal?.aborted) throw new AgUiFailure('FRONTEND_UNAVAILABLE', 409); };
  const require = async (scope: Scope, id: string, action: string, signal: AbortSignal) => {
    check(signal);
    try { await authorization.require(scope, action, { kind: 'tool', id, scope, ownerId: scope.principalId }, { signal }); }
    catch { throw new AgUiFailure('FRONTEND_ACCESS_DENIED', 403); }
    check(signal);
  };
  const locate = (token: string, scope: Scope): { call: Call; binding: Binding } => {
    check(); const call = calls.get(token); const binding = call && bindings.get(owner(scope, call.runId));
    if (!call || !sameScope(call.scope, scope) || !binding || Date.now() >= call.expiresAtMs || Date.now() >= binding.expiresAtMs
      || !binding.tools.includes(call.toolId) || call.status === 'cancelled') throw new AgUiFailure('FRONTEND_CALL_UNAVAILABLE', 409);
    return { call, binding };
  };
  const internals: FrontendInternals = {
    async advertise(tools, scope, signal) {
      check(signal);
      if (tools.length > limits.maxTools) throw new AgUiFailure('FRONTEND_TOOL_LIMIT', 413);
      for (const tool of tools) {
        const expected = definitions.get(tool.name);
        if (!expected || digest(expected) !== digest(tool)) throw new AgUiFailure('FRONTEND_TOOL_MISMATCH', 403);
        await require(scope, tool.name, 'frontend_advertise', signal);
      }
    },
    bind(scope, runId, threadId, tools) {
      check(); const key = owner(scope, runId); const previous = bindings.get(key); const names = tools.map(tool => tool.name).sort();
      if (previous) {
        if (previous.threadId !== threadId || JSON.stringify(previous.tools) !== JSON.stringify(names)) throw new AgUiFailure('FRONTEND_BINDING_CONFLICT', 409);
        return;
      }
      if (bindings.size >= limits.maxRuns) throw new AgUiFailure('FRONTEND_RUN_LIMIT', 429);
      const binding = { scope: Object.freeze({ ...scope }), runId, threadId, tools: Object.freeze(names), expiresAtMs: Date.now() + limits.maxRunMs };
      bindings.set(key, binding); later(() => bindings.delete(key), limits.maxRunMs);
    },
    pending(scope, runId) { return [...calls.values()].some(call => sameScope(call.scope, scope) && call.runId === runId && call.status === 'pending' && call.expiresAtMs > Date.now()); },
    async dispatch(scope, runId, threadId, externalRunId, signal) {
      const candidate = [...calls.values()].find(call => sameScope(call.scope, scope) && call.runId === runId && call.status === 'pending');
      if (!candidate) return undefined;
      const { call, binding } = locate(candidate.token, scope);
      if (binding.threadId !== threadId) throw new AgUiFailure('FRONTEND_BINDING_CONFLICT', 409);
      await require(scope, call.toolId, 'frontend_dispatch', signal); locate(call.token, scope);
      call.dispatchedRunId ??= externalRunId;
      return Object.freeze({ token: call.token, callId: call.callId, toolId: call.toolId, input: call.input, expiresAtMs: call.expiresAtMs });
    },
    async disclose(token, scope, signal) { const { call } = locate(token, scope); await require(scope, call.toolId, 'frontend_dispatch', signal); locate(token, scope); },
    inspect(token, scope) { const { call, binding } = locate(token, scope); return { nativeRunId: call.runId, threadId: binding.threadId, callId: call.callId, toolId: call.toolId, input: call.input }; },
    async claim(token, scope, signal) {
      const { call, binding } = locate(token, scope); await require(scope, call.toolId, 'frontend_execute', signal);
      locate(token, scope);
      if (call.status !== 'pending' || call.dispatchedRunId === undefined) throw new AgUiFailure('FRONTEND_ALREADY_CLAIMED', 409);
      // Publish the claim before returning it. A lost reply cannot authorize a second browser execution.
      call.status = 'claimed'; call.claimId = toBase64Url(crypto.getRandomValues(new Uint8Array(32))); call.claimedThreadId = binding.threadId;
      return { name: call.toolId, input: call.input, claimId: call.claimId, expiresAtMs: call.expiresAtMs };
    },
    async result(token, claimId, scope, threadId, runId, message, expectedToolCallId, signal) {
      const { call, binding } = locate(token, scope);
      if (runId === call.dispatchedRunId || binding.threadId !== threadId || call.claimedThreadId !== threadId || call.claimId !== claimId || message.role !== 'tool' || message.toolCallId !== expectedToolCallId) throw new AgUiFailure('FRONTEND_RESULT_MISMATCH', 409);
      await require(scope, call.toolId, 'frontend_result', signal); locate(token, scope);
      if (utf8ByteLength(message.content) > limits.maxResultBytes) throw new AgUiFailure('FRONTEND_RESULT_LIMIT', 413);
      boundedJson(message, limits.maxResultBytes * 2 + 4096);
      const hash = digest(message);
      if (call.status === 'settled') {
        if (call.resultDigest !== hash || call.continuationRunId !== runId) throw new AgUiFailure('FRONTEND_RESULT_CONFLICT', 409);
        return call.runId;
      }
      if (call.status !== 'claimed') throw new AgUiFailure('FRONTEND_NOT_CLAIMED', 409);
      let value: ClientJson = null;
      if (message.error === undefined) {
        try { value = boundedJson(JSON.parse(message.content), limits.maxResultBytes); }
        catch { throw new AgUiFailure('INVALID_FRONTEND_RESULT', 400); }
      }
      call.status = 'settled'; call.resultDigest = hash; call.continuationRunId = runId;
      if (message.error !== undefined) call.reject(new MayuraError('TOOL_FAILED', 'The frontend tool reported failure.'));
      else call.resolve(value);
      return call.runId;
    },
  };
  const service: AgUiFrontendTools = Object.freeze({ agentId,
    defineTool<I extends Schema, O extends Schema>(config: AgUiFrontendToolOptions<I, O>): ToolDefinition<I, O> {
      check();
      if (definitions.size >= limits.maxTools || definitions.has(config.id) || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > limits.maxRunMs
        || !Number.isSafeInteger(config.costMicros) || config.costMicros < 0) throw new AgUiFailure('INVALID_FRONTEND_TOOL');
      const tool = defineTool({ ...config, capabilities: [...new Set([...config.capabilities, `frontend:${config.id}`])],
        execute: async (input, context): Promise<InferInput<O>> => {
          check(context.signal);
          if (pending >= limits.maxPending || calls.size >= limits.maxCalls) throw new MayuraError('TOOL_FAILED', 'The frontend bridge is at capacity.');
          if ([...calls.values()].some(call => sameScope(call.scope, context.scope) && call.runId === context.runId && call.callId === context.callId)) throw new MayuraError('TOOL_FAILED', 'This frontend call was already dispatched.');
          const admitted = boundedJson(input, limits.maxInputBytes); const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32))); pending++;
          return new Promise<InferInput<O>>((resolve, reject) => {
            let finished = false;
            const settle = (work: () => void) => { if (finished) return; finished = true; pending--; context.signal.removeEventListener('abort', abort); clearTimeout(timer); timers.delete(timer); work(); };
            const call: Call = { token, scope: Object.freeze({ ...context.scope }), runId: context.runId, callId: context.callId, toolId: tool.id,
              input: admitted, expiresAtMs: Date.now() + tool.timeoutMs, status: 'pending', resolve: value => settle(() => resolve(value as InferInput<O>)), reject: error => settle(() => reject(error)) };
            const abort = () => { if (call.status !== 'settled') call.status = 'cancelled'; call.reject(new MayuraError('CANCELLED', 'Frontend observation was cancelled.')); };
            const timer = later(() => { call.status = 'cancelled'; call.reject(new MayuraError('TIMEOUT', 'The frontend tool did not finish in time.')); }, tool.timeoutMs);
            calls.set(token, call); later(() => calls.delete(token), tool.timeoutMs + limits.retentionMs);
            context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort();
          });
        } });
      if (!tool.inputJsonSchema) throw new AgUiFailure('FRONTEND_SCHEMA_REQUIRED');
      definitions.set(tool.id, Object.freeze({ name: tool.id, description: tool.description, parameters: boundedJson(tool.inputJsonSchema, limits.maxInputBytes) as { readonly [key: string]: ClientJson } }));
      return tool;
    },
    async outboxes(input: Parameters<AgUiFrontendTools['outboxes']>[0]) {
      const result: AgUiFrontendOutboxView[] = [];
      for (const call of calls.values()) if (sameScope(call.scope, input.scope) && call.runId === input.runId) {
        await require(input.scope, call.toolId, 'frontend_result', input.signal ?? new AbortController().signal);
        if (call.status === 'cancelled') continue;
        result.push({ nativeRunId: call.runId, callId: call.callId, toolId: call.toolId, status: call.status,
          expiresAtMs: call.expiresAtMs, retainUntilMs: call.expiresAtMs + limits.retentionMs, resultDigest: call.resultDigest ?? null,
          continuationRunId: call.continuationRunId ?? null, acceptedAtMs: null, reservedAtMs: null, delivery: call.status === 'settled' ? 'reserved' : null, purged: false });
      }
      return Object.freeze(result);
    },
    close() { if (closed) return; closed = true; for (const call of calls.values()) if (call.status === 'pending' || call.status === 'claimed') { call.status = 'cancelled'; call.reject(new MayuraError('CANCELLED', 'The frontend bridge closed.')); }
      for (const timer of timers) clearTimeout(timer); timers.clear(); bindings.clear(); calls.clear(); },
  });
  services.set(service, internals); return service;
}
