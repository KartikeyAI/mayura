import { registerToolContinuation } from '@mayura/tools/host';
import { jsonSchemaOf, jsonValue, MayuraError, type InferInput, type Schema, type Scope } from '@mayura/core';
import { defineTool, type ToolDefinition } from '@mayura/tools';
import { sha256Hex, toBase64Url, utf8ByteLength } from '@mayura/core/host';
import type { FrontendToolBinding, FrontendToolCallRecord, FrontendToolRegistration, FrontendToolStoreKey } from '@mayura/storage-contracts';
import type { ClientJson } from '@mayura/client';
import { AgUiFailure, boundedJson, identifier, type AgUiFrontendTool } from './protocol.js';
import { registerFrontendService, type AgUiFrontendTools, type AgUiFrontendToolsOptions, type AgUiFrontendToolOptions, type AgUiFrontendOutboxView, type FrontendInternals } from './frontend-tools.js';

const hash = (value: unknown): string => {
  const canonical = (item: any): string => item === null || typeof item !== 'object' ? JSON.stringify(item) : Array.isArray(item)
    ? `[${item.map(canonical).join(',')}]` : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
  return sha256Hex(canonical(value));
};
/** Shared journal mode. Native owners consume immutable outboxes; recoverable waits park before browser dispatch. */
export function createDurableFrontendTools(options: AgUiFrontendToolsOptions): AgUiFrontendTools {
  const recoverable = options.nativeRecovery !== undefined;
  if (recoverable && (!options.nativeRecovery?.permissions?.allow?.includes('ag-ui:frontend-recover') || typeof options.store?.park !== 'function')) throw new AgUiFailure('PERMISSION_DENIED', 403);
  const store = options.store!; const agentId = identifier(options.agentId); const authorization = options.authorization;
  if (['bind', 'binding', 'register', 'calls', 'read', 'dispatch', 'claim', 'accept', 'reserveResult', 'purgeExpired'].some(method => typeof (store as any)?.[method] !== 'function')) throw new AgUiFailure('INVALID_FRONTEND_STORE');
  const limits = { maxTools: 32, maxPending: 128, maxInputBytes: 65_536, maxResultBytes: 65_536, maxRunMs: 300_000, retentionMs: 60_000,
    storageTimeoutMs: 5000, maxStorageOperations: 32, pollIntervalMs: 100, ...options.limits };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1 || value > 16_777_216) || limits.maxTools > 128
    || limits.maxPending > 10_000 || limits.maxStorageOperations > 1024 || limits.maxRunMs > 3_600_000 || limits.pollIntervalMs > 60_000) throw new AgUiFailure('INVALID_FRONTEND_LIMITS');
  const definitions = new Map<string, { wire: AgUiFrontendTool; registration: FrontendToolRegistration }>();
  const stopped = new AbortController(); let closed = false; let active = 0; let pending = 0;
  const check = (signal?: AbortSignal) => { if (closed || signal?.aborted) throw new AgUiFailure('FRONTEND_UNAVAILABLE', 409); };
  const require = async (scope: Scope, toolId: string, action: string, signal: AbortSignal) => {
    check(signal);
    try { await authorization.require(scope, action, { kind: 'tool', id: toolId, scope, ownerId: scope.principalId }, { signal }); }
    catch { throw new AgUiFailure('FRONTEND_ACCESS_DENIED', 403); }
    check(signal);
  };
  /** Bound storage without freeing slots held by drivers that ignore abort. No ambiguous claim write is repeated. */
  const operation = async <T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> => {
    check(external); if (active >= limits.maxStorageOperations) throw new AgUiFailure('FRONTEND_STORE_BUSY', 429);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let abort: () => void = () => {};
    active++;
    const running = Promise.resolve().then(() => { if (controller.signal.aborted) throw new Error(); return work(controller.signal); });
    void running.then(() => { active--; }, () => { active--; });
    try {
      return await Promise.race([running, new Promise<never>((_, reject) => {
        abort = () => { controller.abort(); reject(new AgUiFailure('FRONTEND_STORE_UNAVAILABLE', 503)); };
        external?.addEventListener('abort', abort, { once: true }); stopped.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, limits.storageTimeoutMs); if (external?.aborted || stopped.signal.aborted) abort();
      })]);
    } catch (error) {
      if (error instanceof AgUiFailure) throw error;
      if (error instanceof MayuraError && error.code === 'CONFLICT') throw new AgUiFailure('FRONTEND_RESULT_CONFLICT', 409);
      throw new AgUiFailure('FRONTEND_STORE_UNAVAILABLE', 503);
    } finally { clearTimeout(timer); external?.removeEventListener('abort', abort); stopped.signal.removeEventListener('abort', abort); controller.abort(); }
  };
  const key = (scope: Scope, token: string, signal?: AbortSignal): FrontendToolStoreKey => ({ scope, agentId, token, ...(signal ? { signal } : {}) });
  const binding = (scope: Scope, runId: string, signal?: AbortSignal) => operation(local => store.binding(scope, agentId, runId, local), signal);
  const read = (scope: Scope, token: string, signal?: AbortSignal) => operation(local => store.read(key(scope, token, local)), signal);
  const locate = async (token: string, scope: Scope, signal?: AbortSignal, forResult = false): Promise<FrontendToolCallRecord> => {
    const call = await read(scope, token, signal); const definition = call && definitions.get(call.toolId);
    if (!call || call.agentId !== agentId || call.scope.principalId !== scope.principalId || call.scope.projectId !== scope.projectId || call.purged
      || Date.now() >= (forResult ? call.retainUntilMs : call.expiresAtMs) || !definition || definition.registration.version !== call.toolVersion
      || definition.registration.digest !== call.definitionDigest) throw new AgUiFailure('FRONTEND_CALL_UNAVAILABLE', 409);
    return call;
  };
  const pause = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); stopped.signal.removeEventListener('abort', abort); reject(new MayuraError('OUTCOME_UNKNOWN', 'Frontend delivery stopped; durable claims must not be replayed.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); stopped.signal.removeEventListener('abort', abort); resolve(); }, limits.pollIntervalMs);
    signal.addEventListener('abort', abort, { once: true }); stopped.signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || stopped.signal.aborted) abort();
  });
  const internals: FrontendInternals = {
    async advertise(tools, scope, signal) {
      check(signal); if (tools.length > limits.maxTools) throw new AgUiFailure('FRONTEND_TOOL_LIMIT', 413);
      for (const tool of tools) {
        const definition = definitions.get(tool.name); if (!definition || hash(definition.wire) !== hash(tool)) throw new AgUiFailure('FRONTEND_TOOL_MISMATCH', 403);
        await require(scope, tool.name, 'frontend_advertise', signal);
      }
    },
    async bind(scope, runId, threadId, tools, signal) {
      const registrations = tools.map(tool => { const item = definitions.get(tool.name); if (!item || hash(item.wire) !== hash(tool)) throw new AgUiFailure('FRONTEND_TOOL_MISMATCH', 403); return item.registration; }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const value: FrontendToolBinding = { scope, agentId, runId, threadId, tools: registrations, expiresAtMs: Date.now() + limits.maxRunMs };
      await operation(local => store.bind(value, local), signal);
    },
    async pending(scope, runId, signal) {
      const calls = await operation(local => store.calls(scope, agentId, runId, local), signal);
      return calls.some(call => call.status === 'pending' && call.waitState !== 'prepared' && !call.purged && call.expiresAtMs > Date.now());
    },
    async dispatch(scope, runId, threadId, externalRunId, signal) {
      const calls = await operation(local => store.calls(scope, agentId, runId, local), signal);
      const candidate = calls.find(call => call.status === 'pending' && call.waitState !== 'prepared' && !call.purged && call.expiresAtMs > Date.now()); if (!candidate) return undefined;
      const call = await locate(candidate.token, scope, signal);
      if (call.threadId !== threadId) throw new AgUiFailure('FRONTEND_BINDING_CONFLICT', 409);
      await require(scope, call.toolId, 'frontend_dispatch', signal);
      const saved = await operation(local => store.dispatch(key(scope, call.token, local), externalRunId), signal);
      return { token: saved.token, callId: saved.callId, toolId: saved.toolId, input: boundedJson(saved.input, limits.maxInputBytes), expiresAtMs: saved.expiresAtMs };
    },
    async disclose(token, scope, signal) { const call = await locate(token, scope, signal); await require(scope, call.toolId, 'frontend_dispatch', signal); await locate(token, scope, signal); },
    async inspect(token, scope, signal, forResult) {
      const call = await locate(token, scope, signal, forResult);
      return { nativeRunId: call.runId, threadId: call.threadId, callId: call.callId, toolId: call.toolId, input: boundedJson(call.input, limits.maxInputBytes) };
    },
    async claim(token, scope, signal) {
      const call = await locate(token, scope, signal); await require(scope, call.toolId, 'frontend_execute', signal);
      const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      const saved = await operation(local => store.claim(key(scope, token, local), nonce), signal);
      if (saved.claimId !== nonce || saved.status !== 'claimed') throw new AgUiFailure('FRONTEND_ALREADY_CLAIMED', 409);
      return { name: saved.toolId, input: boundedJson(saved.input, limits.maxInputBytes), claimId: nonce, expiresAtMs: saved.expiresAtMs };
    },
    async result(token, claimId, scope, threadId, runId, message, expectedToolCallId, signal) {
      const call = await locate(token, scope, signal, true);
      if (message.role !== 'tool' || message.toolCallId !== expectedToolCallId || threadId !== call.threadId || claimId !== call.claimId || runId === call.dispatchedRunId) throw new AgUiFailure('FRONTEND_RESULT_MISMATCH', 409);
      await require(scope, call.toolId, 'frontend_result', signal);
      if (utf8ByteLength(message.content) > limits.maxResultBytes) throw new AgUiFailure('FRONTEND_RESULT_LIMIT', 413);
      boundedJson(message, limits.maxResultBytes * 2 + 4096);
      let value: ClientJson = null;
      if (message.error === undefined) { try { value = boundedJson(JSON.parse(message.content), limits.maxResultBytes); } catch { throw new AgUiFailure('INVALID_FRONTEND_RESULT'); } }
      await operation(local => store.accept(key(scope, token, local), { claimId, threadId, continuationRunId: runId,
        requestDigest: hash(message), value: jsonValue(value, { maxBytes: limits.maxResultBytes }), failed: message.error !== undefined }), signal);
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
          check(context.signal); if (pending >= limits.maxPending) throw new MayuraError('LIMIT_EXCEEDED', 'Frontend waiter capacity exhausted.'); pending++;
          const consumerId = crypto.randomUUID(); let call: FrontendToolCallRecord | undefined;
          try {
            while (!await binding(context.scope, context.runId, context.signal)) await pause(context.signal);
            const registration = definitions.get(tool.id)!.registration;
            call = await operation(local => store.register({ scope: context.scope, agentId, runId: context.runId, callId: context.callId, toolId: tool.id,
              toolVersion: registration.version, definitionDigest: registration.digest, input: jsonValue(input, { maxBytes: limits.maxInputBytes }), timeoutMs: tool.timeoutMs, retentionMs: limits.retentionMs, ...(recoverable ? { recoverable: true } : {}), signal: local }), context.signal);
            while (true) {
              check(context.signal);
              if (call.purged || Date.now() >= call.expiresAtMs) throw new MayuraError('OUTCOME_UNKNOWN', 'Frontend execution expired; do not replay it.');
              if (call.outbox) {
                await require(context.scope, tool.id, 'frontend_result', context.signal);
                const reserved = await operation(local => store.reserveResult(key(context.scope, call!.token, local), consumerId), context.signal);
                if (!reserved.outbox || reserved.outbox.consumerId !== consumerId) throw new MayuraError('OUTCOME_UNKNOWN', 'Frontend result ownership is uncertain.');
                if (reserved.outbox.failed) throw new MayuraError('TOOL_FAILED', 'The frontend tool reported failure.');
                return boundedJson(reserved.outbox.value, limits.maxResultBytes) as InferInput<O>;
              }
              await pause(context.signal); call = await read(context.scope, call.token, context.signal) ?? undefined;
              if (!call) throw new MayuraError('OUTCOME_UNKNOWN', 'Frontend journal record disappeared.');
            }
          } catch (error) {
            if (error instanceof MayuraError && ['TOOL_FAILED', 'OUTCOME_UNKNOWN'].includes(error.code)) throw error;
            throw new MayuraError('OUTCOME_UNKNOWN', 'Frontend result delivery could not be confirmed. Do not replay browser execution.');
          } finally { pending--; }
        } });
      if (!tool.inputJsonSchema) throw new AgUiFailure('FRONTEND_SCHEMA_REQUIRED');
      const wire = boundedJson({ name: tool.id, description: tool.description, parameters: tool.inputJsonSchema }, limits.maxInputBytes + 16_384) as unknown as AgUiFrontendTool;
      const registration = { id: tool.id, version: tool.version, digest: hash({ wire, ...(recoverable ? { nativeRecovery: true } : {}), version: tool.version, effects: tool.effects, capabilities: tool.capabilities,
        costMicros: tool.costMicros, timeoutMs: tool.timeoutMs, output: jsonSchemaOf(config.output) ?? null }) };
      definitions.set(tool.id, { wire, registration });
      if (recoverable) {
        const proof = (call: FrontendToolCallRecord) => hash({ runId: call.runId, callId: call.callId, token: call.token,
          inputDigest: call.inputDigest, definitionDigest: call.definitionDigest });
        const savedCall = async (context: import('@mayura/tools/host').ToolContinuationContext, expected: string) => {
          const calls = await operation(local => store.calls(context.scope, agentId, context.runId, local), context.signal);
          const call = calls.find(item => item.callId === context.callId);
          if (!call || !call.waitState || proof(call) !== expected) throw new AgUiFailure('FRONTEND_BINDING_CONFLICT', 409);
          await locate(call.token, context.scope, context.signal); return call;
        };
        registerToolContinuation(tool, {
          async prepare(input, context) {
            while (!await binding(context.scope, context.runId, context.signal)) await pause(context.signal);
            await require(context.scope, tool.id, 'frontend_dispatch', context.signal);
            const call = await operation(local => store.register({ scope: context.scope, agentId, runId: context.runId, callId: context.callId,
              toolId: tool.id, toolVersion: registration.version, definitionDigest: registration.digest, input,
              timeoutMs: tool.timeoutMs, retentionMs: limits.retentionMs, recoverable: true, signal: local }), context.signal);
            return { digest: proof(call), expiresAtMs: call.expiresAtMs };
          },
          async publish(_input, context, digest) {
            const call = await savedCall(context, digest); await require(context.scope, tool.id, 'frontend_dispatch', context.signal);
            await operation(local => store.park!(key(context.scope, call.token, local)), context.signal);
          },
          async ready(_input, context, digest) {
            const call = await savedCall(context, digest); await require(context.scope, tool.id, 'frontend_result', context.signal);
            return call.status === 'settled' && call.outbox !== null && call.outbox.consumerId === null;
          },
        });
      }
      return tool;
    },
    async outboxes(input: Parameters<AgUiFrontendTools['outboxes']>[0]) {
      const result: AgUiFrontendOutboxView[] = [];
      const calls = await operation(local => store.calls(input.scope, agentId, input.runId, local), input.signal);
      for (const call of calls) {
        await require(input.scope, call.toolId, 'frontend_result', input.signal ?? stopped.signal);
        result.push({ ...(call.waitState ? { waitState: call.waitState } : {}), nativeRunId: call.runId, callId: call.callId, toolId: call.toolId, status: call.status, expiresAtMs: call.expiresAtMs, retainUntilMs: call.retainUntilMs,
          resultDigest: call.outbox?.requestDigest ?? null, continuationRunId: call.outbox?.continuationRunId ?? null, acceptedAtMs: call.outbox?.acceptedAtMs ?? null,
          reservedAtMs: call.outbox?.reservedAtMs ?? null, delivery: call.outbox ? (call.outbox.consumerId === null ? 'pending' : 'reserved') : null, purged: call.purged });
      }
      return Object.freeze(result);
    },
    close() { if (closed) return; closed = true; stopped.abort(); },
  });
  registerFrontendService(service, internals); return service;
}
