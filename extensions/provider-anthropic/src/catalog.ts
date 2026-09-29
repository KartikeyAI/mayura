import type { CatalogModel, ModelCatalog } from 'mayura';

/** A model's list prices in dollars per million tokens. Anthropic bills the full context window at these rates. */
function listed(input: number, output: number, contextTokens: number, maxOutputTokens: number): CatalogModel {
  const micros = (dollars: number) => Math.round(dollars * 1_000_000);
  return Object.freeze({ pricing: Object.freeze({ inputMicrosPerMillionTokens: micros(input), outputMicrosPerMillionTokens: micros(output) }), contextTokens, maxOutputTokens });
}

/**
 * Anthropic's standard list prices on the date below, from https://platform.claude.com/docs/en/about-claude/pricing,
 * used only when a registry opts in with `prices: 'catalog'`. Prices change: check the date, and give your own prices
 * when they matter. Requests pinned to a region with `inference_geo` cost 10% more; give those prices yourself.
 */
export const catalog: ModelCatalog = Object.freeze({
  asOf: '2026-09-29',
  models: Object.freeze({
    'claude-fable-5-1': listed(10, 50, 1_000_000, 128_000),
    'claude-opus-5-5': listed(4, 20, 1_000_000, 128_000),
    'claude-sonnet-5-5': listed(2, 10, 1_000_000, 128_000),
    'claude-haiku-4-5': listed(1, 5, 200_000, 64_000),
    'claude-haiku-4-5-20251001': listed(1, 5, 200_000, 64_000),
  }),
});
