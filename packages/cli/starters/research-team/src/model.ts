import type { JsonObject, ModelAdapter } from 'mayura/core';
import { anthropicMessages } from 'mayura/provider-anthropic';
import { openAICompatibleChat, openAIResponses } from 'mayura/provider-openai';
import { z } from 'mayura';
import type { ModelSettings } from './config.js';

/**
 * The configured model for one agent. `offline` returns the agent's own rule-based stand-in: it performs no inference,
 * needs no key and costs nothing, so the whole starter runs and tests without a network. Set MAYURA_MODEL_PROVIDER to
 * `openai`, `anthropic` or `compatible` (any OpenAI-compatible endpoint) to use a real model with the same agent, tools
 * and output schema. Each compatible provider gets its own adapter id, `openai-compatible.<MAYURA_MODEL_PROVIDER_ID>`.
 */
export function selectModel(settings: ModelSettings, agent: { readonly outputJsonSchema: JsonObject; readonly offline: ModelAdapter }): ModelAdapter {
  if (settings.provider === 'offline') return agent.offline;
  const options = { model: settings.name, outputJsonSchema: agent.outputJsonSchema,
    maxCostMicros: settings.maxCallCostMicros, pricing: settings.pricing, timeoutMs: 30_000 };
  if (settings.provider === 'compatible') {
    return openAICompatibleChat({ ...options, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}), endpoint: settings.endpoint,
      remote: { id: settings.providerId, auth: settings.auth }, output: settings.output, strictTools: settings.strictTools,
      ...(settings.tokenLimitField ? { tokenLimitField: settings.tokenLimitField } : {}),
      ...(settings.gatewayToken ? { headers: { 'cf-aig-authorization': `Bearer ${settings.gatewayToken}` } } : {}) });
  }
  // Directly, or through a gateway (MAYURA_MODEL_ENDPOINT, with MAYURA_MODEL_GATEWAY_TOKEN; the key may stay in the gateway).
  const headers = settings.gatewayToken ? { 'cf-aig-authorization': `Bearer ${settings.gatewayToken}` } : undefined;
  const via = { ...(settings.endpoint ? { endpoint: settings.endpoint } : {}), ...(headers ? { headers } : {}) };
  const credentials = settings.apiKey ? { apiKey: settings.apiKey, ...via } : { endpoint: settings.endpoint!, headers: headers! };
  return settings.provider === 'openai' ? openAIResponses({ ...options, ...credentials }) : anthropicMessages({ ...options, ...credentials });
}

/** Runtimes must allow each model explicitly, as `model:<adapter id>`. */
export const modelPermission = (model: ModelAdapter): string => `model:${model.id}`;

/**
 * A zod schema as the plain JSON Schema object a tool or provider takes. Zod attaches non-enumerable metadata and
 * Mayura accepts only plain JSON, so the result is round-tripped through JSON; `$schema` is dropped for providers.
 */
export function jsonSchema(schema: z.ZodType): JsonObject {
  const { $schema: _dialect, ...plain } = JSON.parse(JSON.stringify(z.toJSONSchema(schema))) as JsonObject;
  return plain;
}
