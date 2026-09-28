import type { ModelAdapter } from 'mayura/core';
import { anthropicMessages } from 'mayura/provider-anthropic';
import { openAICompatibleChat, openAIResponses } from 'mayura/provider-openai';
import type { ModelSettings } from './config.js';

/**
 * The configured model. `offline` returns the agent's own rule-based stand-in: it performs no inference, needs no key
 * and costs nothing, so the whole starter runs and tests without a network. Set MAYURA_MODEL_PROVIDER to `openai`,
 * `anthropic` or `compatible` (any OpenAI-compatible endpoint) to use a real model with the same agent and tools.
 *
 * No JSON Schemas here: Mayura generates them from the agent's and tools' Zod schemas and sends them with every call,
 * and `defineAgent` checks them against the provider's rules before anything runs.
 */
export function selectModel(settings: ModelSettings, offline: ModelAdapter): ModelAdapter {
  if (settings.provider === 'offline') return offline;
  // Generous: a turn may wait for tool results between calls, but each call itself is one request.
  const options = { model: settings.name, maxCostMicros: settings.maxCallCostMicros, pricing: settings.pricing, timeoutMs: 60_000 };
  if (settings.provider === 'compatible') {
    return openAICompatibleChat({ ...options, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}), endpoint: settings.endpoint,
      remote: { id: settings.providerId, auth: settings.auth }, output: settings.output, strictTools: settings.strictTools,
      ...(settings.gatewayToken ? { headers: { 'cf-aig-authorization': `Bearer ${settings.gatewayToken}` } } : {}) });
  }
  return settings.provider === 'openai' ? openAIResponses({ ...options, apiKey: settings.apiKey }) : anthropicMessages({ ...options, apiKey: settings.apiKey });
}

/** Runtimes must allow each model explicitly, as `model:<adapter id>`. */
export const modelPermission = (model: ModelAdapter): string => `model:${model.id}`;
