import { gatewayProvider, gatewayCredential, type GatewayOptions, type GatewayProvider } from '@mayurajs/provider-openai';
import { MayuraError } from 'mayura';

export type { GatewayProvider } from '@mayurajs/provider-openai';

/** Explicit host configuration; no credential discovery or automatic catalog requests. */
export interface HeliconeOptions extends GatewayOptions {
  readonly apiKey: string;
}

/** Helicone as a registry provider. Configure prices and grant model:<provider>/<model> explicitly. */
export function helicone(options: HeliconeOptions): GatewayProvider {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'Gateway options are required.');
  return gatewayProvider(options, { id: 'helicone', baseURL: 'https://ai-gateway.helicone.ai', apiKey: gatewayCredential(options.apiKey), reportedCost: { usageField: 'cost' }, models: true, modelsPath: 'v1/models' });
}
