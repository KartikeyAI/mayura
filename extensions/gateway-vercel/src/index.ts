import { gatewayProvider, gatewayCredential, type GatewayOptions, type GatewayProvider } from '@mayurajs/provider-openai';
import { MayuraError } from 'mayura';

export type { GatewayProvider } from '@mayurajs/provider-openai';

/** Explicit host configuration; no credential discovery or automatic catalog requests. */
export interface VercelGatewayOptions extends GatewayOptions {
  readonly apiKey: string;
}

/** Vercel AI Gateway as a registry provider. Configure prices and grant model:<provider>/<model> explicitly. */
export function vercelGateway(options: VercelGatewayOptions): GatewayProvider {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'Gateway options are required.');
  return gatewayProvider(options, { id: 'vercel', baseURL: 'https://ai-gateway.vercel.sh/v1', apiKey: gatewayCredential(options.apiKey), reportedCost: { usageField: 'cost' }, models: true });
}
