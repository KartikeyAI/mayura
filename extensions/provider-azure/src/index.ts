import { responsesProvider } from '@mayurajs/provider-openai';
import { MayuraError, type CatalogModel, type ModelCatalog, type ModelMediaCapability, type ModelProvider } from 'mayura';
import { catalog } from './catalog.js';

export { catalog };

export interface AzureProviderOptions {
  /** Your Azure OpenAI resource: requests go to https://<resource>.openai.azure.com/openai/v1. Give this or `baseURL`. */
  readonly resource?: string;
  /** The v1 API's base URL, for example a custom domain or a gateway (https only). Give this or `resource`. */
  readonly baseURL?: string;
  /** The resource's API key. Give this or `token`. */
  readonly apiKey?: string;
  /** A Microsoft Entra ID access token source, called for every request so tokens stay fresh. Give this or `apiKey`. */
  readonly token?: () => Promise<string>;
  /**
   * Your deployments, by deployment name, with the model and deployment type each runs. Models are called by
   * deployment name (`azure/<deployment>`), so catalog prices apply only to deployments listed here; Global deployments
   * are the ones with catalog prices.
   */
  readonly deployments?: Readonly<Record<string, { readonly model: string; readonly type: 'global' }>>;
  /** Extra headers, such as a gateway's credential. They cannot replace Authorization or api-key. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly media?: ModelMediaCapability | false;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 60 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. Never selected from model output. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Azure OpenAI models for a Mayura model registry, through the official OpenAI SDK and Azure's v1 API (the Responses
 * API), with an API key or a Microsoft Entra ID token:
 *
 * ```ts
 * const models = createModels({
 *   providers: [azure({ resource: 'contoso', apiKey, deployments: { 'prod-chat': { model: 'gpt-5.5', type: 'global' } } })],
 *   prices: 'catalog', maxCallCostMicros: 50_000,
 * });
 * const model = models.model('azure/prod-chat'); // granted as model:azure/prod-chat
 * ```
 *
 * It is `responsesProvider` from `@mayurajs/provider-openai` with Azure's address and credentials, so everything that
 * package promises holds: strict schemas, streaming, bounded responses, no SDK retries and nothing read from the
 * environment.
 */
export function azure(options: AzureProviderOptions): ModelProvider {
  if (!options || (options.resource === undefined) === (options.baseURL === undefined)) {
    throw new MayuraError('INVALID_CONFIG', 'azure() needs either a resource name or a baseURL.');
  }
  if (options.resource !== undefined && (typeof options.resource !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/iu.test(options.resource))) {
    throw new MayuraError('INVALID_CONFIG', 'The Azure resource name is letters, digits and -.');
  }
  if ((options.apiKey === undefined) === (options.token === undefined)) throw new MayuraError('INVALID_CONFIG', 'azure() needs either an apiKey or a token source.');
  if (options.token !== undefined && typeof options.token !== 'function') throw new MayuraError('INVALID_CONFIG', 'The Azure token source must be a function.');
  const models: Record<string, CatalogModel> = {};
  for (const [deployment, entry] of Object.entries(options.deployments ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(deployment)) throw new MayuraError('INVALID_CONFIG', `The Azure deployment name ${JSON.stringify(deployment)} is not valid.`);
    // Data Zone and Regional deployments cost more than Global ones; the catalog has only Global prices.
    if (entry?.type !== 'global') throw new MayuraError('INVALID_CONFIG', `Catalog prices are for Global deployments; give ${deployment}'s prices yourself.`);
    const listed = catalog.models[entry.model];
    if (!listed) throw new MayuraError('INVALID_CONFIG', `The Azure catalog has no ${entry.model}; give ${deployment}'s prices yourself.`);
    models[deployment] = listed;
  }
  const deployed: ModelCatalog | undefined = Object.keys(models).length ? Object.freeze({ asOf: catalog.asOf, models: Object.freeze(models) }) : undefined;
  const { resource: _resource, baseURL: _baseURL, apiKey: _apiKey, token: _token, deployments: _deployments, ...shared } = options;
  return responsesProvider({
    ...shared, id: 'azure',
    baseURL: options.baseURL ?? `https://${options.resource}.openai.azure.com/openai/v1`,
    apiKey: options.apiKey ?? options.token!,
    ...(deployed ? { catalog: deployed } : {}),
  });
}
