import { gatewayProvider, gatewayCredential, type GatewayOptions, type GatewayProvider } from '@mayurajs/provider-openai';
import { MayuraError } from 'mayura';

export type { GatewayProvider } from '@mayurajs/provider-openai';

/** Explicit host configuration; no credential discovery or automatic catalog requests. */
export interface CloudflareGatewayOptions extends GatewayOptions {
  readonly accountId: string;
  readonly gatewayId: string;
  /** Cloudflare AI Gateway token, including when the gateway holds the upstream key. */
  readonly apiKey: string;
  /** Optional upstream provider credential for BYOK passthrough. */
  readonly providerApiKey?: string;
}

/** Cloudflare AI Gateway as a registry provider. Configure prices and grant model:<provider>/<model> explicitly. */
export function cloudflareGateway(options: CloudflareGatewayOptions): GatewayProvider {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'Gateway options are required.');
  if (!/^[a-fA-F0-9]{32}$/u.test(options.accountId) || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(options.gatewayId)) {
    throw new MayuraError('INVALID_CONFIG', 'Cloudflare needs a valid account id and gateway name.');
  }
  return gatewayProvider(options, { id: 'cloudflare', baseURL: `https://gateway.ai.cloudflare.com/v1/${options.accountId}/${options.gatewayId}/compat`,
    ...(options.providerApiKey === undefined ? {} : { apiKey: gatewayCredential(options.providerApiKey) }),
    headers: { 'cf-aig-authorization': `Bearer ${gatewayCredential(options.apiKey)}` }, reportedCost: { usageField: 'cost' } });
}
