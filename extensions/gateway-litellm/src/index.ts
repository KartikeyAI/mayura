import { gatewayProvider, gatewayCredential, type GatewayOptions, type GatewayProvider } from '@mayurajs/provider-openai';
import { MayuraError } from 'mayura';

export type { GatewayProvider } from '@mayurajs/provider-openai';

/** Explicit host configuration; no credential discovery or automatic catalog requests. */
export interface LitellmOptions extends GatewayOptions {
  readonly apiKey: string;
  /** Explicit HTTPS proxy base, including /v1 when configured there. */
  readonly baseURL: string;
}

/** LiteLLM as a registry provider. Configure prices and grant model:<provider>/<model> explicitly. */
export function litellm(options: LitellmOptions): GatewayProvider {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'Gateway options are required.');
  return gatewayProvider(options, { id: 'litellm', baseURL: options.baseURL, apiKey: gatewayCredential(options.apiKey), reportedCost: { usageField: 'cost', header: 'x-litellm-response-cost' }, models: true });
}
