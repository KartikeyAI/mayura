import type { CatalogModel, ModelCatalog } from 'mayura';

/** A model's on-demand list prices in dollars per million tokens. */
function listed(input: number, output: number, contextTokens: number, maxOutputTokens: number): CatalogModel {
  const micros = (dollars: number) => Math.round(dollars * 1_000_000);
  return Object.freeze({ pricing: Object.freeze({ inputMicrosPerMillionTokens: micros(input), outputMicrosPerMillionTokens: micros(output) }), contextTokens, maxOutputTokens });
}

/**
 * Groq's on-demand list prices on the date below, from https://console.groq.com/docs/models, used only when a registry
 * opts in with `prices: 'catalog'`. Prices change: check the date, and give your own prices when they matter.
 *
 * Conservative by design: cached input is charged at the full input rate, and models Groq sells only through sales
 * (Llama 3.3 70B Versatile and Llama 3.1 8B Instant, on this date) are left out. Batch and Flex tier prices differ.
 */
export const catalog: ModelCatalog = Object.freeze({
  asOf: '2026-09-29',
  models: Object.freeze({
    'openai/gpt-oss-120b': listed(0.15, 0.6, 131_072, 65_536),
    'openai/gpt-oss-20b': listed(0.075, 0.3, 131_072, 65_536),
    'qwen/qwen3.8-27b': listed(0.8, 4, 131_072, 16_384),
  }),
});
