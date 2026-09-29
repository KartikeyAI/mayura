import type { CatalogModel, ModelCatalog } from 'mayura';

/** A model's list prices in dollars per million tokens. Mistral bills the whole context window at these rates. */
function listed(input: number, output: number): CatalogModel {
  const micros = (dollars: number) => Math.round(dollars * 1_000_000);
  return Object.freeze({ pricing: Object.freeze({ inputMicrosPerMillionTokens: micros(input), outputMicrosPerMillionTokens: micros(output) }), contextTokens: 256_000 });
}

/**
 * Mistral's list prices on the date below, from https://docs.mistral.ai/getting-started/models/, used only when a
 * registry opts in with `prices: 'catalog'`. Prices change: check the date, and give your own prices when they matter.
 *
 * Only dated model versions are listed: a `-latest` alias moves to a newer model, whose price can differ. Give an
 * alias's prices yourself if you call one.
 */
export const catalog: ModelCatalog = Object.freeze({
  asOf: '2026-09-29',
  models: Object.freeze({
    'mistral-medium-3-5': listed(1.5, 7.5),
    'mistral-large-2512': listed(0.5, 1.5),
    'mistral-small-2603': listed(0.15, 0.6),
    'ministral-8b-2512': listed(0.15, 0.15),
  }),
});
