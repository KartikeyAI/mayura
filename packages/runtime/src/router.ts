import { MayuraError, ModelInvocationError, freezeJson, jsonValue, type JsonObject, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type ModelStreamEvent } from '@mayura/core';
import { streamModelCall } from '@mayura/core/host';
import { isIdentifier } from './agent.js';
import { modelCost, modelFailureCost } from './response.js';

/** One observed attempt. Metadata only: no prompt, output, credential or provider error text. */
export interface ModelRouterAttempt {
  readonly route: number;
  readonly modelId: string;
  readonly outcome: 'succeeded' | 'failed' | 'skipped';
  /** Why an attempt failed or was skipped. */
  readonly reason?: 'timeout' | 'failed' | 'circuit_open';
  /** Confirmed cost of this attempt; null when unknown (then the attempt's full bound is charged). */
  readonly costMicros: number | null;
}

export interface ModelRouterOptions {
  /** The router's own adapter id; runtimes grant it as `model:<id>`. Granting the router grants every route. */
  readonly id: string;
  /** Adapters in priority order (1–8). Each keeps its own destination, credentials, prices and per-call bound. */
  readonly routes: readonly ModelAdapter[];
  /** Most routes tried for one call (default: every route). */
  readonly maxAttempts?: number;
  /** A route that fails `failureThreshold` calls in a row (default 3) is skipped for `cooldownMs` (default 30 s), then tried once. */
  readonly circuit?: { readonly failureThreshold?: number; readonly cooldownMs?: number };
  /** Trusted observer for metrics and logs. It cannot change routing; its exceptions are ignored. */
  readonly onAttempt?: (attempt: ModelRouterAttempt) => void;
  readonly now?: () => number;
}

export interface ModelRouterRouteStatus {
  readonly route: number; readonly modelId: string; readonly state: 'closed' | 'open' | 'half_open';
  readonly consecutiveFailures: number; readonly openUntilMs: number | null;
}
export interface ModelRouter extends ModelAdapter {
  /** This process's circuit state for each route. */
  status(): readonly ModelRouterRouteStatus[];
}

interface Circuit { failures: number; openUntil: number | null; trial: boolean }
const noFailover = new Set(['INVALID_CONFIG', 'PERMISSION_DENIED', 'INVALID_INPUT']);

/**
 * A model adapter that tries other adapters in priority order when one is unavailable.
 *
 * - Fails over after a timeout, a provider or transport failure, a rate limit or an unusable response; never after the
 *   caller cancels, and never after a configuration or authorization error, which would repeat on every route.
 * - Accounting stays conservative: the router's per-call bound is the sum of the bounds of the routes it may try, a
 *   failed attempt with a confirmed cost is charged that cost, and one with an unknown cost is charged its full bound.
 * - A run stays on the route that holds its provider continuation. If that route fails, the call moves to another
 *   route with only Mayura's portable message history, never another provider's protocol state.
 * - Circuit state lives in this process only.
 */
export function createModelRouter(options: ModelRouterOptions): ModelRouter {
  const { id, routes } = options;
  if (!isIdentifier(id) || !Array.isArray(routes) || routes.length < 1 || routes.length > 8) {
    throw new MayuraError('INVALID_CONFIG', 'A model router needs an identifier and 1–8 routes.');
  }
  for (const route of routes) {
    if (!route || typeof route.generate !== 'function' || !isIdentifier(route.id) || !Number.isSafeInteger(route.maxCostMicros) || route.maxCostMicros < 0) {
      throw new MayuraError('INVALID_CONFIG', 'Every route must be a model adapter with a bounded per-call cost.');
    }
  }
  const maxAttempts = options.maxAttempts ?? routes.length;
  const threshold = options.circuit?.failureThreshold ?? 3; const cooldownMs = options.circuit?.cooldownMs ?? 30_000;
  for (const [name, value, max] of [['maxAttempts', maxAttempts, routes.length], ['failureThreshold', threshold, 1_000], ['cooldownMs', cooldownMs, 86_400_000]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new MayuraError('INVALID_CONFIG', `Router ${name} is out of range.`);
  }
  const now = options.now ?? Date.now;
  // The reservation must cover every attempt the router may make: the largest `maxAttempts` bounds.
  const maxCostMicros = [...routes].map(route => route.maxCostMicros).sort((a, b) => b - a).slice(0, maxAttempts).reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(maxCostMicros)) throw new MayuraError('INVALID_CONFIG', 'Router cost bounds exceed supported accounting.');
  const circuits: Circuit[] = routes.map(() => ({ failures: 0, openUntil: null, trial: false }));
  const observe = (attempt: ModelRouterAttempt): void => { try { options.onAttempt?.(Object.freeze(attempt)); } catch { /* Observation never changes routing. */ } };

  /** The router's continuation names the route and carries that route's own opaque state. */
  const pinned = (continuation: JsonValue | undefined): { route: number; inner?: JsonValue } | undefined => {
    if (continuation === undefined) return undefined;
    const value = continuation as JsonObject;
    const route = value !== null && typeof value === 'object' && !Array.isArray(value) && value['router'] === id ? value['route'] : undefined;
    if (typeof route !== 'number' || !Number.isSafeInteger(route) || route < 0 || route >= routes.length) {
      throw new MayuraError('MODEL_FAILED', 'The model router received continuation it did not issue.');
    }
    return Object.hasOwn(value, 'inner') ? { route, inner: value['inner']! } : { route };
  };
  const available = (index: number): boolean => {
    const circuit = circuits[index]!;
    if (circuit.openUntil === null) return true;
    if (now() < circuit.openUntil || circuit.trial) return false;
    circuit.trial = true; return true; // half-open: one trial call
  };
  const succeeded = (index: number): void => { circuits[index] = { failures: 0, openUntil: null, trial: false }; };
  const failed = (index: number): void => {
    const circuit = circuits[index]!; circuit.failures += 1; circuit.trial = false;
    if (circuit.failures >= threshold) circuit.openUntil = now() + cooldownMs;
  };

  type Attempt = (adapter: ModelAdapter, request: ModelRequest) => Promise<ModelResponse>;
  /**
   * Try routes in order. Once `committed()` is true (a stream has released text), a failure ends the call instead of
   * moving to another route.
   */
  const route = async (request: ModelRequest, attempt: Attempt, committed: () => boolean): Promise<ModelResponse> => {
    if (request.signal.aborted) throw new MayuraError('CANCELLED', 'The model call was cancelled.');
    const pin = pinned(request.continuation);
    const order = pin ? [pin.route, ...routes.map((_, index) => index).filter(index => index !== pin.route)] : routes.map((_, index) => index);
    let spent = 0; let unknown = false; let attempts = 0;
    const stop = (): never => { throw unknown ? new MayuraError('MODEL_FAILED', 'The model router could not complete the call.') : new ModelInvocationError(spent); };
    for (const index of order) {
      if (attempts >= maxAttempts) break;
      const adapter = routes[index]!;
      if (!available(index)) { observe({ route: index, modelId: adapter.id, outcome: 'skipped', reason: 'circuit_open', costMicros: null }); continue; }
      attempts += 1;
      const { continuation: _ignored, ...portable } = request;
      const inner: ModelRequest = pin?.route === index && pin.inner !== undefined ? { ...portable, continuation: pin.inner } : portable;
      let response: ModelResponse;
      try { response = await attempt(adapter, Object.freeze(inner)); }
      catch (error) {
        if (request.signal.aborted) throw new MayuraError('CANCELLED', 'The model call was cancelled.');
        const known = modelFailureCost(error);
        if (known === undefined) { unknown = true; spent += adapter.maxCostMicros; } else spent += known;
        failed(index);
        const final = (error instanceof MayuraError && noFailover.has(error.code)) || committed();
        observe({ route: index, modelId: adapter.id, outcome: 'failed',
          reason: !final && error instanceof MayuraError && error.code === 'CANCELLED' ? 'timeout' : 'failed', costMicros: known ?? null });
        if (final) return stop();
        continue;
      }
      let cost: number;
      try { cost = modelCost(response); }
      catch {
        unknown = true; spent += adapter.maxCostMicros; failed(index);
        observe({ route: index, modelId: adapter.id, outcome: 'failed', reason: 'failed', costMicros: null });
        if (committed()) return stop();
        continue;
      }
      succeeded(index);
      observe({ route: index, modelId: adapter.id, outcome: 'succeeded', costMicros: cost });
      const continuation = freezeJson(jsonValue({ router: id, route: index, ...(response.continuation === undefined ? {} : { inner: response.continuation }) }));
      const usage = { costMicros: spent + cost };
      return response.type === 'final' ? { type: 'final', output: response.output, usage, continuation } : { type: 'tool_calls', calls: response.calls, usage, continuation };
    }
    return stop();
  };

  return Object.freeze({
    id,
    capabilities: Object.freeze({ tools: routes.every(route => route.capabilities.tools), structuredOutput: routes.every(route => route.capabilities.structuredOutput) }),
    maxCostMicros,
    status: () => Object.freeze(routes.map((adapter, index) => {
      const circuit = circuits[index]!; const open = circuit.openUntil !== null;
      return Object.freeze({ route: index, modelId: adapter.id, consecutiveFailures: circuit.failures, openUntilMs: circuit.openUntil,
        state: !open ? 'closed' as const : now() < circuit.openUntil! && !circuit.trial ? 'open' as const : 'half_open' as const });
    })),
    generate: (request: ModelRequest): Promise<ModelResponse> => route(request, (adapter, inner) => adapter.generate(inner), () => false),
    /**
     * Streams from the first available route. It can fail over only until the first delta has been released: after
     * that the reader has seen one provider's text, and switching would splice two answers, so the call fails instead.
     * A route without streaming answers through `generate`.
     */
    stream: (request: ModelRequest): AsyncIterable<ModelStreamEvent> => streamModelCall((onDelta, consumer) => {
      let released = false;
      const signal = AbortSignal.any([request.signal, consumer]);
      return route({ ...request, signal }, async (adapter, inner) => {
        if (!adapter.stream) return adapter.generate(inner);
        let final: ModelResponse | undefined;
        for await (const event of adapter.stream(inner)) {
          if (final !== undefined) throw new MayuraError('MODEL_FAILED', 'The model stream continued after its response.');
          if (event?.type === 'output.delta' && typeof event.text === 'string') { released = true; onDelta(event.text); }
          else if (event?.type === 'response') final = event.response;
          else throw new MayuraError('MODEL_FAILED', 'The model stream produced an invalid event.');
        }
        if (final === undefined) throw new MayuraError('MODEL_FAILED', 'The model stream ended without a response.');
        return final;
      }, () => released);
    }),
  });
}
