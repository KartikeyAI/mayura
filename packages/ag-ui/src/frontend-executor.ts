import type { ClientJson } from '@mayura/client';
import { sha256Hex } from '@mayura/core/host';
import { AgUiFailure, boundedJson, fields, object, type AgUiFrontendContinuation, type AgUiFrontendDispatchMetadata, type AgUiMessage } from './protocol.js';

export interface AgUiFrontendHandlerContext { readonly signal: AbortSignal; readonly executionId: string }
export interface AgUiFrontendExecutorOptions {
  readonly publicOrigin: string; readonly path?: string; readonly token: () => string | Promise<string>;
  readonly permissions: { readonly allow: readonly string[] };
  readonly handlers: Readonly<Record<string, (input: ClientJson, context: AgUiFrontendHandlerContext) => ClientJson | Promise<ClientJson>>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly limits?: { readonly timeoutMs?: number; readonly maxResultBytes?: number; readonly maxClaimBytes?: number; readonly maxConcurrent?: number; readonly maxClaims?: number };
}
export interface AgUiFrontendExecution {
  readonly message: Extract<AgUiMessage, { readonly role: 'tool' }>;
  readonly forwardedProps: { readonly mayuraFrontend: AgUiFrontendContinuation };
}
export interface AgUiFrontendExecutor {
  /** Claim once before running the handler. Never retries a claim or a handler after an uncertain result. */
  execute(call: { readonly toolCallId: string; readonly toolCallName: string; readonly metadata: AgUiFrontendDispatchMetadata }, options?: { readonly signal?: AbortSignal }): Promise<AgUiFrontendExecution>;
}
/** Browser-safe helper. Browser return values are untrusted assertions; native schemas/guards release them. */
export function createAgUiFrontendExecutor(options: AgUiFrontendExecutorOptions): AgUiFrontendExecutor {
  if (!options.permissions?.allow?.includes('ag-ui:frontend-execute') || typeof options.token !== 'function') throw new AgUiFailure('PERMISSION_DENIED', 403);
  const origin = new URL(options.publicOrigin); const path = options.path ?? '/ag-ui'; const claimPath = `${path}/frontend-tools/claim`;
  if (origin.origin !== options.publicOrigin || !['https:', 'http:'].includes(origin.protocol) || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    || !/^\/[A-Za-z0-9/_-]+$/.test(path)) throw new AgUiFailure('INVALID_CONFIG');
  const limits = { timeoutMs: 30_000, maxResultBytes: 65_536, maxClaimBytes: 131_072, maxConcurrent: 32, maxClaims: 1024, ...options.limits };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1 || value > 16_777_216) || limits.maxConcurrent > 1024 || limits.maxClaims > 10_000 || limits.timeoutMs > 3_600_000) throw new AgUiFailure('INVALID_FRONTEND_LIMITS');
  const handlers = new Map(Object.entries(options.handlers)); const permissions = new Set(options.permissions.allow);
  if (handlers.size > 128 || [...handlers.values()].some(handler => typeof handler !== 'function')) throw new AgUiFailure('INVALID_FRONTEND_HANDLERS');
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis); const getToken = options.token; const seen = new Set<string>(); let active = 0;
  return Object.freeze({
    async execute(raw: Parameters<AgUiFrontendExecutor['execute']>[0], settings?: { readonly signal?: AbortSignal }): Promise<AgUiFrontendExecution> {
      const call = object(boundedJson(raw, 16_384)); fields(call, ['toolCallId', 'toolCallName', 'metadata'], ['type', 'parentMessageId', 'timestamp']);
      if (call['type'] !== undefined && call['type'] !== 'TOOL_CALL_START') throw new AgUiFailure('INVALID_FRONTEND_DISPATCH');
      const metadata = object(call['metadata']); fields(metadata, ['mayura']); const mayura = object(metadata['mayura']); fields(mayura, ['frontend']);
      const delivery = object(mayura['frontend']); fields(delivery, ['token', 'expiresAtMs', 'claimPath']);
      const token = delivery['token']; const name = call['toolCallName']; const id = call['toolCallId'];
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || typeof name !== 'string' || typeof id !== 'string' || id.length > 128
        || !Number.isSafeInteger(delivery['expiresAtMs']) || (delivery['expiresAtMs'] as number) <= Date.now() || delivery['claimPath'] !== claimPath) throw new AgUiFailure('INVALID_FRONTEND_DISPATCH');
      const handler = handlers.get(name);
      if (!handler || !permissions.has(`frontend:${name}`)) throw new AgUiFailure('PERMISSION_DENIED', 403);
      if (seen.has(token) || seen.size >= limits.maxClaims || active >= limits.maxConcurrent) throw new AgUiFailure('FRONTEND_EXECUTOR_LIMIT', 409);
      if (settings?.signal?.aborted) throw new AgUiFailure('ABORTED', 408);
      seen.add(token); active++;
      const controller = new AbortController(); let abort: () => void = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
      let handlerWork: Promise<ClientJson> | undefined;
      const once = async (): Promise<AgUiFrontendExecution> => {
        const credential = await getToken();
        if (controller.signal.aborted) throw new AgUiFailure('ABORTED', 408);
        if (typeof credential !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(credential)) throw new AgUiFailure('INVALID_CREDENTIAL', 401);
        const response = await transport(new URL(claimPath, origin), { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          body: JSON.stringify({ token }), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
        if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== origin.origin)
          || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { void response.body?.cancel().catch(() => {}); throw new AgUiFailure('FRONTEND_CLAIM_FAILED', 409); }
        const reader = response.body?.getReader(); if (!reader) throw new AgUiFailure('FRONTEND_CLAIM_FAILED', 503);
        const chunks: Uint8Array[] = []; let bytes = 0; let complete = false;
        try {
          while (true) { const chunk = await reader.read(); if (chunk.done) { complete = true; break; } bytes += chunk.value.byteLength;
            if (bytes > limits.maxClaimBytes) throw new AgUiFailure('FRONTEND_CLAIM_LIMIT', 413); chunks.push(chunk.value); }
        } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
        const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        const claim = object(boundedJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)), limits.maxClaimBytes));
        fields(claim, ['name', 'input', 'claimId', 'expiresAtMs', 'toolCallId']);
        if (claim['name'] !== name || claim['toolCallId'] !== id || claim['expiresAtMs'] !== delivery['expiresAtMs'] || Date.now() >= (claim['expiresAtMs'] as number)
          || typeof claim['claimId'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claim['claimId'])) throw new AgUiFailure('FRONTEND_CLAIM_MISMATCH', 409);
        if (controller.signal.aborted) throw new AgUiFailure('ABORTED', 408);
        let content = 'null'; let failed = false;
        handlerWork = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new AgUiFailure('ABORTED', 408);
          return handler(claim['input'] as ClientJson, Object.freeze({ signal: controller.signal, executionId: sha256Hex(`mayura/frontend/${token}`) }));
        });
        try { content = JSON.stringify(boundedJson(await handlerWork, limits.maxResultBytes)); }
        catch { if (controller.signal.aborted) throw new AgUiFailure('FRONTEND_EXECUTION_UNCERTAIN', 409); failed = true; }
        return { message: { id: `frontend-${sha256Hex(token)}`, role: 'tool', toolCallId: id, content, ...(failed ? { error: 'FRONTEND_TOOL_FAILED' } : {}) },
          forwardedProps: { mayuraFrontend: { token, claimId: claim['claimId'] } } };
      };
      const work = once();
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          abort = () => { controller.abort(); reject(new AgUiFailure('FRONTEND_EXECUTION_UNCERTAIN', 409)); };
          settings?.signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(abort, Math.max(1, Math.min(limits.timeoutMs, (delivery['expiresAtMs'] as number) - Date.now())));
          if (settings?.signal?.aborted) abort();
        })]);
      } catch (error) {
        if (error instanceof AgUiFailure) throw error;
        throw new AgUiFailure('FRONTEND_EXECUTION_UNCERTAIN', 409);
      } finally {
        clearTimeout(timer); settings?.signal?.removeEventListener('abort', abort); controller.abort();
        // Hold capacity until even an uncooperative transport/token getter/handler has actually settled.
        void work.then(() => { active--; }, () => { active--; });
      }
    },
  });
}
