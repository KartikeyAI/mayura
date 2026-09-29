import type { CatalogModel, ModelCatalog } from 'mayura';

const micros = (dollars: number) => Math.round(dollars * 1_000_000);
/** List prices in dollars per million tokens; `long` are the rates for prompts over 200K tokens, when a model has them. */
function listed(input: number, output: number, long?: { input: number; output: number }): CatalogModel {
  return Object.freeze({
    pricing: Object.freeze({
      inputMicrosPerMillionTokens: micros(input), outputMicrosPerMillionTokens: micros(output),
      ...(long ? { longContext: Object.freeze({ aboveInputTokens: 200_000, inputMicrosPerMillionTokens: micros(long.input), outputMicrosPerMillionTokens: micros(long.output) }) } : {}),
    }),
    contextTokens: 1_048_576, maxOutputTokens: 65_536,
  });
}

/**
 * The Gemini API's paid-tier list prices on the date below, from https://ai.google.dev/gemini-api/docs/pricing, used
 * only when a registry opts in with `prices: 'catalog'`. Prices change: check the date, and give your own prices when
 * they matter.
 *
 * Conservative by design, so a budget never undercounts. Gemini 3.8 Flash is listed at the price Google has announced
 * from January 1, 2027 ($1.50 and $7.50), twice its price until then. Cached input is charged at the full input rate,
 * and where a model bills audio input higher than text, the higher rate is listed.
 */
export const catalog: ModelCatalog = Object.freeze({
  asOf: '2026-09-29',
  models: Object.freeze({
    'gemini-3.8-flash': listed(1.5, 7.5),
    'gemini-3.5-flash': listed(1.5, 9),
    'gemini-3.5-flash-lite': listed(0.3, 2.5),
    'gemini-3.1-flash-lite': listed(0.5, 1.5),
    'gemini-3.1-pro-preview': listed(2, 12, { input: 4, output: 18 }),
    'gemini-2.5-pro': listed(1.25, 10, { input: 2.5, output: 15 }),
  }),
});
