import { MayuraError, ModelProviderError, type ModelAdapter, type ModelMediaCapability, type ModelRequest, type ModelResponse, type ModelStreamEvent } from '@mayura/core';
import { isModelId } from './agent.js';
import { modelCost, modelFailureCost, modelTokens } from './response.js';
import { createModelRouter, failureReason, failureStatus, type ModelRouter, type ModelRouterOptions } from './router.js';

/** List prices in micros (millionths of a US dollar) per million tokens. */
export interface ModelPricing {
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  /**
   * Higher rates for the whole call once its input exceeds `aboveInputTokens`, as some providers bill long prompts.
   * They must be at least the standard rates. Provider packages charge them (`tokenCostMicros` in `mayura/core/host`).
   */
  readonly longContext?: {
    readonly aboveInputTokens: number;
    readonly inputMicrosPerMillionTokens: number;
    readonly outputMicrosPerMillionTokens: number;
  };
}

/** What a provider package is given to build one model's adapter. */
export interface ProviderModelSettings {
  /** The adapter's id, `<provider>/<model>`: the adapter must use it, and runtimes grant it as `model:<id>`. */
  readonly id: string;
  readonly pricing: ModelPricing;
  /** The most one call may cost; the runtime reserves it before every call. */
  readonly maxCostMicros: number;
  /** How long one call may take before it fails with `timeout`. */
  readonly timeoutMs?: number;
}

/** A model a provider's catalog knows about, with the list prices on the catalog's date. */
export interface CatalogModel {
  readonly pricing: ModelPricing;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly media?: ModelMediaCapability;
}

/** A provider's models and list prices as of `asOf` (YYYY-MM-DD). Prices change: check the date. */
export interface ModelCatalog {
  readonly asOf: string;
  readonly models: Readonly<Record<string, CatalogModel>>;
}

/** A model provider, as `@mayurajs/provider-*` packages export it. */
export interface ModelProvider {
  /** Lowercase letters, digits and `-`, such as `openai`: the first part of every model id. */
  readonly id: string;
  readonly catalog?: ModelCatalog;
  /** Builds the adapter for one model. `name` is the provider's own model name, such as `gpt-5.1`. */
  model(name: string, settings: ProviderModelSettings): ModelAdapter;
}

export interface ModelsOptions {
  /** The providers models may come from. */
  readonly providers: readonly ModelProvider[];
  /** The most one model call may cost, unless a model sets its own. Required: nothing is spent without a bound. */
  readonly maxCallCostMicros: number;
  /**
   * Where prices come from. A map from model id (`openai/gpt-5.1`) to prices, or `'catalog'` to use the list prices
   * each provider package ships, as of its catalog's date. A model with no price is refused.
   */
  readonly prices?: 'catalog' | Readonly<Record<string, ModelPricing>>;
  /** How long one call may take (default: each provider's own default). */
  readonly timeoutMs?: number;
}

export interface ModelOptions {
  /** This model's prices; overrides `prices`. */
  readonly pricing?: ModelPricing;
  /** This model's per-call bound; overrides `maxCallCostMicros`. */
  readonly maxCostMicros?: number;
  readonly timeoutMs?: number;
  /**
   * Call the same model again after a rate limit, an unavailable provider or a timeout (never after the caller cancels,
   * and never once streamed text was released). Model calls change nothing outside, so this is safe; every attempt is
   * charged, and the per-call bound becomes `attempts` times the model's bound.
   */
  readonly retry?: { readonly attempts: number; readonly backoffMs?: number };
}

export interface ModelChainOptions extends Omit<ModelRouterOptions, 'id' | 'routes'> {
  /** Options for individual models of the chain, by model id. */
  readonly models?: Readonly<Record<string, ModelOptions>>;
}

export interface RegisteredModel {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  /** Where the price comes from: this registry's `prices`, or the provider's catalog of that date. */
  readonly pricing: ModelPricing | null;
  readonly catalogAsOf: string | null;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelRegistry {
  /** The adapter for one model, by id (`openai/gpt-5.1`). Its id is that model id; grant it as `model:<id>`. */
  model(id: string, options?: ModelOptions): ModelAdapter;
  /**
   * A router over several models, tried in order (see `createModelRouter`). Its id is yours to choose and is what
   * runtimes grant: granting a chain grants every model in it.
   */
  chain(id: string, models: readonly string[], options?: ModelChainOptions): ModelRouter;
  /** Every model with a price this registry can use: explicitly priced models, then catalog models. */
  list(): readonly RegisteredModel[];
}

const providerIdentifier = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const catalogDate = /^\d{4}-\d{2}-\d{2}$/u;
const retryable = new Set(['rate_limited', 'unavailable', 'timeout']);

function pricingOf(value: unknown, where: string): ModelPricing {
  const pricing = value as Partial<ModelPricing> | null;
  for (const key of ['inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens'] as const) {
    const price = pricing?.[key];
    if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0) throw new MayuraError('INVALID_CONFIG', `${where} needs ${key} as a non-negative integer.`);
  }
  const standard = { inputMicrosPerMillionTokens: pricing!.inputMicrosPerMillionTokens!, outputMicrosPerMillionTokens: pricing!.outputMicrosPerMillionTokens! };
  if (pricing!.longContext === undefined) return Object.freeze(standard);
  const long = pricing!.longContext as Partial<NonNullable<ModelPricing['longContext']>> | null;
  if (!long || typeof long !== 'object' || typeof long.aboveInputTokens !== 'number' || !Number.isSafeInteger(long.aboveInputTokens) || long.aboveInputTokens < 1) {
    throw new MayuraError('INVALID_CONFIG', `${where} needs longContext.aboveInputTokens as a positive integer.`);
  }
  for (const key of ['inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens'] as const) {
    const price = long[key];
    // Long prompts never cost less: a lower rate would let the long-context tier undercount a call.
    if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < standard[key]) throw new MayuraError('INVALID_CONFIG', `${where} needs longContext.${key} as an integer at least the standard rate.`);
  }
  return Object.freeze({ ...standard, longContext: Object.freeze({ aboveInputTokens: long.aboveInputTokens, inputMicrosPerMillionTokens: long.inputMicrosPerMillionTokens!, outputMicrosPerMillionTokens: long.outputMicrosPerMillionTokens! }) });
}

function bound(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', `${where} must be a non-negative integer.`);
  return value;
}

function timeout(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 100 || value > 3_600_000) throw new MayuraError('INVALID_CONFIG', `${where} must be 100 to 3,600,000 ms.`);
  return value;
}

/**
 * Models from many providers, by id. Each provider package (`@mayurajs/provider-openai`, `-anthropic`, ...) knows how to
 * call its provider; the registry gives every model an id of the form `<provider>/<model>`, a price and a per-call
 * bound, and builds routers over them.
 *
 * Nothing is guessed. Every model needs a price, from `prices` or from a provider's dated catalog when you opt in with
 * `prices: 'catalog'`, and every call has a bound. Runtimes grant each model, or each chain, as `model:<id>`.
 */
export function createModels(options: ModelsOptions): ModelRegistry {
  if (!options || !Array.isArray(options.providers) || options.providers.length < 1 || options.providers.length > 64) {
    throw new MayuraError('INVALID_CONFIG', 'A model registry needs 1–64 providers.');
  }
  const providers = new Map<string, ModelProvider>();
  for (const provider of options.providers) {
    if (!provider || typeof provider.model !== 'function' || typeof provider.id !== 'string' || !providerIdentifier.test(provider.id)) {
      throw new MayuraError('INVALID_CONFIG', 'Every provider needs an id of lowercase letters, digits and -, and a model() function.');
    }
    if (providers.has(provider.id)) throw new MayuraError('INVALID_CONFIG', `Provider ${provider.id} is listed twice.`);
    if (provider.catalog !== undefined && (typeof provider.catalog?.asOf !== 'string' || !catalogDate.test(provider.catalog.asOf) || !provider.catalog.models || typeof provider.catalog.models !== 'object')) {
      throw new MayuraError('INVALID_CONFIG', `Provider ${provider.id} has a catalog without a YYYY-MM-DD date or models.`);
    }
    providers.set(provider.id, provider);
  }
  const maxCallCostMicros = bound(options.maxCallCostMicros, 'maxCallCostMicros');
  const registryTimeout = timeout(options.timeoutMs, 'timeoutMs');
  const useCatalog = options.prices === 'catalog';
  const explicit = new Map<string, ModelPricing>();
  if (options.prices !== undefined && !useCatalog) {
    if (!options.prices || typeof options.prices !== 'object') throw new MayuraError('INVALID_CONFIG', "prices must be 'catalog' or a map from model id to prices.");
    for (const [id, pricing] of Object.entries(options.prices)) explicit.set(id, pricingOf(pricing, `The price of ${id}`));
  }

  const parse = (id: unknown): { provider: ModelProvider; name: string; id: string } => {
    if (!isModelId(id) || !id.includes('/')) throw new MayuraError('INVALID_CONFIG', 'A model id is <provider>/<model>, for example openai/gpt-5.1.');
    const slash = id.indexOf('/'); const provider = providers.get(id.slice(0, slash)); const name = id.slice(slash + 1);
    if (!provider) throw new MayuraError('INVALID_CONFIG', `No provider ${id.slice(0, slash)} is registered; add its @mayurajs/provider-* package.`);
    return { provider, name, id };
  };
  const priceOf = (id: string, provider: ModelProvider, name: string, override: ModelPricing | undefined): ModelPricing => {
    if (override) return pricingOf(override, `The price of ${id}`);
    const configured = explicit.get(id); if (configured) return configured;
    const listed = useCatalog ? provider.catalog?.models[name] : undefined;
    if (listed) return pricingOf(listed.pricing, `The catalog price of ${id}`);
    throw new MayuraError('INVALID_CONFIG', `No price for ${id}: give it in prices or pricing${useCatalog ? '' : ", or use prices: 'catalog'"}.`);
  };

  const model = (id: string, modelOptions: ModelOptions = {}): ModelAdapter => {
    const parsed = parse(id);
    const pricing = priceOf(parsed.id, parsed.provider, parsed.name, modelOptions.pricing);
    const maxCostMicros = modelOptions.maxCostMicros === undefined ? maxCallCostMicros : bound(modelOptions.maxCostMicros, `The maxCostMicros of ${id}`);
    const timeoutMs = timeout(modelOptions.timeoutMs, `The timeoutMs of ${id}`) ?? registryTimeout;
    const adapter = parsed.provider.model(parsed.name, Object.freeze({ id: parsed.id, pricing, maxCostMicros, ...(timeoutMs === undefined ? {} : { timeoutMs }) }));
    if (!adapter || adapter.id !== parsed.id || typeof adapter.generate !== 'function' || adapter.maxCostMicros !== maxCostMicros) {
      throw new MayuraError('INVALID_CONFIG', `Provider ${parsed.provider.id} returned an adapter that does not use the id and cost bound it was given.`);
    }
    return modelOptions.retry === undefined ? adapter : withRetries(adapter, modelOptions.retry);
  };

  return Object.freeze({
    model,
    chain(id: string, models: readonly string[], chainOptions: ModelChainOptions = {}): ModelRouter {
      if (!Array.isArray(models) || models.length < 1 || models.length > 8 || new Set(models).size !== models.length) {
        throw new MayuraError('INVALID_CONFIG', 'A chain needs 1–8 different model ids.');
      }
      const { models: perModel = {}, ...router } = chainOptions;
      return createModelRouter({ ...router, id, routes: models.map(ref => model(ref, perModel[ref])) });
    },
    list(): readonly RegisteredModel[] {
      const seen = new Set<string>(); const result: RegisteredModel[] = [];
      for (const [id, pricing] of explicit) {
        const slash = id.indexOf('/'); const provider = providers.get(id.slice(0, slash)); if (!provider) continue;
        const listed = provider.catalog?.models[id.slice(slash + 1)];
        seen.add(id);
        result.push(Object.freeze({ id, provider: provider.id, name: id.slice(slash + 1), pricing, catalogAsOf: null,
          ...(listed?.contextTokens === undefined ? {} : { contextTokens: listed.contextTokens }),
          ...(listed?.maxOutputTokens === undefined ? {} : { maxOutputTokens: listed.maxOutputTokens }) }));
      }
      for (const provider of providers.values()) {
        for (const [name, listed] of Object.entries(provider.catalog?.models ?? {})) {
          const id = `${provider.id}/${name}`; if (seen.has(id) || !isModelId(id)) continue;
          result.push(Object.freeze({ id, provider: provider.id, name, pricing: useCatalog ? listed.pricing : null, catalogAsOf: provider.catalog!.asOf,
            ...(listed.contextTokens === undefined ? {} : { contextTokens: listed.contextTokens }),
            ...(listed.maxOutputTokens === undefined ? {} : { maxOutputTokens: listed.maxOutputTokens }) }));
        }
      }
      return Object.freeze(result);
    },
  });
}

/** Wait `ms`, or fail with CANCELLED as soon as the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new MayuraError('CANCELLED', 'The model call was cancelled.')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new MayuraError('CANCELLED', 'The model call was cancelled.')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The same adapter, called again after transient failures. See `ModelOptions.retry`. */
function withRetries(adapter: ModelAdapter, retry: { readonly attempts: number; readonly backoffMs?: number }): ModelAdapter {
  const attempts = retry?.attempts; const backoffMs = retry?.backoffMs ?? 500;
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) throw new MayuraError('INVALID_CONFIG', 'retry.attempts must be 1 to 5.');
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0 || backoffMs > 60_000) throw new MayuraError('INVALID_CONFIG', 'retry.backoffMs must be 0 to 60,000.');
  const maxCostMicros = adapter.maxCostMicros * attempts;
  if (!Number.isSafeInteger(maxCostMicros)) throw new MayuraError('INVALID_CONFIG', 'The retried cost bound exceeds supported accounting.');

  /**
   * Runs attempts until one succeeds. `run` performs one attempt and reports whether streamed text was released,
   * after which a failure is final. Known costs are summed; an attempt whose cost is unknown is charged its full bound.
   */
  const attemptAll = async <T>(request: ModelRequest, run: (released: () => void) => Promise<T>, settle: (result: T, spent: number) => T): Promise<T> => {
    let spent = 0; let unknown = false;
    for (let attempt = 1; ; attempt++) {
      let released = false;
      try {
        const result = await run(() => { released = true; });
        return settle(result, spent);
      } catch (error) {
        const cost = modelFailureCost(error);
        if (cost === undefined) { unknown = true; spent += adapter.maxCostMicros; } else spent += cost;
        const reason = failureReason(error) ?? (error instanceof MayuraError && error.code === 'CANCELLED' && !request.signal.aborted ? 'timeout' : undefined);
        if (attempt >= attempts || released || request.signal.aborted || !reason || !retryable.has(reason)) {
          if (attempt === 1 || !reason) throw error;
          const status = failureStatus(error);
          throw new ModelProviderError(reason ?? 'unavailable', { ...(status === undefined ? {} : { httpStatus: status }), ...(unknown ? {} : { costMicros: spent }) });
        }
        await pause(backoffMs * 2 ** (attempt - 1), request.signal);
      }
    }
  };
  const charged = (response: ModelResponse, spent: number): ModelResponse => spent === 0 ? response
    : Object.freeze({ ...response, usage: Object.freeze({ ...modelTokens(response), costMicros: modelCost(response) + spent }) });

  return Object.freeze({
    id: adapter.id, capabilities: adapter.capabilities, maxCostMicros,
    ...(adapter.checkDefinition ? { checkDefinition: adapter.checkDefinition.bind(adapter) } : {}),
    generate: (request: ModelRequest) => attemptAll(request, () => adapter.generate(request), charged),
    ...(adapter.stream ? {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        // Deltas are buffered per attempt only until released; a failed attempt that released nothing is retried.
        const events: ModelStreamEvent[] = []; let notify: (() => void) | undefined; let finished = false; let failure: unknown;
        const push = (event: ModelStreamEvent) => { events.push(event); notify?.(); };
        const done = attemptAll(request, async released => {
          let response: ModelResponse | undefined;
          for await (const event of adapter.stream!(request)) {
            if (event.type === 'output.delta') { released(); push(event); } else response = event.response;
          }
          if (!response) throw new ModelProviderError('invalid_response');
          return response;
        }, charged).then(response => { push({ type: 'response', response }); }, error => { failure = error; })
          .finally(() => { finished = true; notify?.(); });
        while (true) {
          if (events.length) { yield events.shift()!; continue; }
          if (finished) break;
          await new Promise<void>(resolve => { notify = resolve; });
          notify = undefined;
        }
        await done;
        if (failure !== undefined) throw failure;
      },
    } : {}),
  });
}
