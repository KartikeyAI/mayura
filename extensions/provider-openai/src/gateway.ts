import { assertPositiveInteger, jsonValue, MayuraError, ModelProviderError, type JsonObject, type ModelCatalog, type ModelMediaCapability, type ModelProvider, type Permissions, type ProviderModelSettings } from 'mayura';
import { providerEndpoint, providerHeaders, providerHttpFailure } from 'mayura/core/host';
import { openAICompatibleChat } from 'mayura/provider-openai';

/** Host-owned settings shared by the gateway packages. Discovery never supplies prices or permissions. */
export interface GatewayOptions {
  readonly baseURL?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly catalog?: ModelCatalog;
  readonly output?: 'json_schema' | 'json_object';
  readonly strictTools?: boolean;
  readonly tokenLimitField?: 'max_tokens' | 'max_completion_tokens';
  readonly media?: ModelMediaCapability;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}
/** A registry provider with explicit, bounded, non-paginating discovery where the gateway supports it. */
export interface GatewayProvider extends ModelProvider {
  readonly discovery: boolean;
  listModels(options: { readonly permissions: Permissions; readonly signal: AbortSignal }): Promise<readonly string[]>;
}
/** Protocol binding for a gateway, supplied only by host code. Never derived from model output. */
export interface GatewayBinding {
  readonly id: string;
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonObject;
  readonly models?: boolean;
  readonly modelsPath?: 'models' | 'v1/models';
  readonly reportedCost?: { readonly usageField?: string; readonly header?: string };
}
/** Validate credentials without echoing them in errors. */
export function gatewayCredential(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\r\n]/u.test(value)) {
    throw new MayuraError('INVALID_CONFIG', 'A gateway credential must be a nonempty bounded header value.');
  }
  return value;
}
/** Shared Chat Completions transport. It never retries paid work or fetches a catalog implicitly. */
export function gatewayProvider(options: GatewayOptions, binding: GatewayBinding): GatewayProvider {
  if (!binding || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(binding.id)) throw new MayuraError('INVALID_CONFIG', 'A gateway id is required.');
  const baseURL = providerEndpoint(options.baseURL ?? binding.baseURL, '', 'gateway').replace(/\/+$/u, '');
  const owned = binding.headers ?? {};
  const extra = providerHeaders(options.headers, ['Authorization', 'api-key', ...Object.keys(owned)], 'gateway');
  const headers = providerHeaders({ ...extra, ...providerHeaders(owned, ['Authorization', 'api-key'], 'gateway') }, ['Authorization', 'api-key'], 'gateway');
  const apiKey = binding.apiKey === undefined ? undefined : gatewayCredential(binding.apiKey);
  if (apiKey === undefined && Object.keys(owned).length === 0) throw new MayuraError('INVALID_CONFIG', 'A gateway credential is required.');
  const timeout = options.timeoutMs ?? 60_000;
  assertPositiveInteger(timeout, 'timeoutMs');
  if (timeout > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'Gateway timeout exceeds the supported timer range.');
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  assertPositiveInteger(maxResponseBytes, 'maxResponseBytes');
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new MayuraError('INVALID_CONFIG', 'A gateway transport is required.');
  let discovering = false;
  return Object.freeze({
    id: binding.id, discovery: binding.models === true,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    model(name: string, settings: ProviderModelSettings) {
      if (settings.id !== `${binding.id}/${name}`) throw new MayuraError('INVALID_CONFIG', 'Gateway model ids must match their registry provider.');
      const adapter = openAICompatibleChat({
        endpoint: `${baseURL}/chat/completions`, remote: { id: binding.id }, model: name,
        ...(apiKey === undefined ? {} : { apiKey }), headers,
        pricing: settings.pricing, maxCostMicros: settings.maxCostMicros,
        timeoutMs: settings.timeoutMs ?? timeout,
        ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }), maxResponseBytes,
        fetch: transport,
        ...(binding.body === undefined ? {} : { body: binding.body }),
        ...(binding.reportedCost === undefined ? {} : { reportedCost: binding.reportedCost }),
        ...(options.media === undefined ? {} : { media: options.media }),
        ...(options.output === undefined ? {} : { output: options.output }),
        ...(options.strictTools === undefined ? {} : { strictTools: options.strictTools }),
        ...(options.tokenLimitField === undefined ? {} : { tokenLimitField: options.tokenLimitField }),
      });
      return Object.freeze({ ...adapter, id: settings.id });
    },
    async listModels(request: { readonly permissions: Permissions; readonly signal: AbortSignal }): Promise<readonly string[]> {
      if (!request.permissions.allow.includes(`gateway:${binding.id}:models`)) throw new MayuraError('PERMISSION_DENIED', 'Gateway model discovery is not permitted.');
      if (request.signal.aborted) throw new MayuraError('CANCELLED', 'Gateway discovery was cancelled.');
      if (!binding.models) throw new MayuraError('INVALID_CONFIG', 'This gateway has no supported inference-endpoint discovery route.');
      if (discovering) throw new MayuraError('INVALID_CONFIG', 'Gateway discovery is already in progress.');
      discovering = true;
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), timeout);
      let stop: (() => void) | undefined;
      // Keep the slot until the underlying transport settles, even when it ignores cancellation.
      const operation = (async () => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await transport(`${baseURL}/${binding.modelsPath ?? 'models'}`, { method: 'GET', headers: { ...headers, ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }) }, redirect: 'error', signal });
          if (signal.aborted) { void response.body?.cancel().catch(() => undefined); throw new MayuraError('CANCELLED', 'Gateway discovery was cancelled.'); }
          if (!response.ok || response.redirected || !response.body) {
            void response.body?.cancel().catch(() => undefined);
            if (!response.ok) throw providerHttpFailure(response.status);
            throw new ModelProviderError('invalid_response');
          }
          reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8', { fatal: true }); let text = ''; let size = 0;
          const limit = Math.min(maxResponseBytes, 262_144);
          while (true) {
            const chunk = await reader.read(); if (signal.aborted) throw new MayuraError('CANCELLED', 'Gateway discovery was cancelled.');
            if (chunk.done) { text += decoder.decode(); break; }
            size += chunk.value.byteLength; if (size > limit) throw new ModelProviderError('invalid_response');
            text += decoder.decode(chunk.value, { stream: true });
          }
          const payload = jsonValue(JSON.parse(text), { maxBytes: limit });
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload['data']) || payload['data'].length > 1000) throw new ModelProviderError('invalid_response');
          const ids = payload['data'].map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item['id'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u.test(item['id'])) throw new ModelProviderError('invalid_response');
            return item['id'];
          });
          if (new Set(ids).size !== ids.length) throw new ModelProviderError('invalid_response');
          return Object.freeze(ids);
        } finally { void reader?.cancel().catch(() => undefined); discovering = false; }
      })();
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          stop = () => reject(new MayuraError('CANCELLED', 'Gateway discovery was cancelled or timed out.'));
          signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
        })]);
      } catch (error) {
        const cancelled = signal.aborted; controller.abort();
        if (error instanceof ModelProviderError) throw error;
        if (cancelled) throw new MayuraError('CANCELLED', 'Gateway discovery was cancelled or timed out.');
        throw new ModelProviderError('invalid_response');
      } finally { clearTimeout(timer); if (stop) signal.removeEventListener('abort', stop); }
    },
  });
}
