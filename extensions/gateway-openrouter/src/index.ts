import { gatewayProvider, gatewayCredential, type GatewayOptions, type GatewayProvider } from '@mayurajs/provider-openai';
import { MayuraError } from 'mayura';

export type { GatewayProvider } from '@mayurajs/provider-openai';

/** Explicit host configuration; no credential discovery or automatic catalog requests. */
export interface OpenrouterOptions extends GatewayOptions {
  readonly apiKey: string;
}

/** OpenRouter as a registry provider. Configure prices and grant model:<provider>/<model> explicitly. */
export function openrouter(options: OpenrouterOptions): GatewayProvider {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'Gateway options are required.');
  return gatewayProvider(options, { id: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: gatewayCredential(options.apiKey), reportedCost: { usageField: 'cost' }, models: true, body: { provider: { require_parameters: true, allow_fallbacks: false } } });
}
