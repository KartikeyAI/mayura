import { gatewayProvider, gatewayCredential, type GatewayOptions, type GatewayProvider } from '@mayurajs/provider-openai';
import { MayuraError } from 'mayura';

export type { GatewayProvider } from '@mayurajs/provider-openai';

/** Explicit host configuration; no credential discovery or automatic catalog requests. */
export interface PortkeyOptions extends GatewayOptions {
  readonly apiKey: string;
  /** A provider integration saved in the Portkey model catalog, for example @openai. */
  readonly provider: string;
}

/** Portkey as a registry provider. Configure prices and grant model:<provider>/<model> explicitly. */
export function portkey(options: PortkeyOptions): GatewayProvider {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'Gateway options are required.');
  if (typeof options.provider !== 'string' || !/^@[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(options.provider)) {
    throw new MayuraError('INVALID_CONFIG', 'Portkey needs a saved provider integration such as @openai.');
  }
  return gatewayProvider(options, { id: 'portkey', baseURL: 'https://api.portkey.ai/v1',
    headers: { 'x-portkey-api-key': gatewayCredential(options.apiKey), 'x-portkey-provider': options.provider }, reportedCost: { usageField: 'cost' }, models: true });
}
