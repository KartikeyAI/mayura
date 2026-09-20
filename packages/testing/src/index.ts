import { MayuraError, jsonValue, type ModelAdapter, type ModelRequest, type ModelResponse } from '@mayura/core';

/**
 * Deterministic test-only model. It never performs inference or network requests.
 * Each call consumes a scripted response; exhaustion is an error, not a fabricated answer.
 */
export function scriptedModel(
  responses: readonly (ModelResponse | ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>))[],
  options: { readonly id?: string; readonly maxCostMicros?: number } = {},
): ModelAdapter {
  const steps = [...responses];
  let position = 0;
  return Object.freeze({
    id: options.id ?? 'scripted',
    capabilities: Object.freeze({ tools: true, structuredOutput: true }),
    maxCostMicros: options.maxCostMicros ?? 0,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      request.signal.throwIfAborted();
      const response = steps[position++];
      if (!response) throw new MayuraError('MODEL_FAILED', 'The test model script is exhausted.');
      const result = typeof response === 'function' ? await response(request) : response;
      // Copy snapshots so a runtime cannot mutate a later test's scripted response.
      return jsonValue(result) as unknown as ModelResponse;
    },
  });
}
