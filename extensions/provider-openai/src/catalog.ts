import type { CatalogModel, ModelCatalog } from 'mayura';

/**
 * A model's list prices in dollars per million tokens, with OpenAI's long-context rule: a prompt over 272K input tokens
 * is billed at twice the input rate and one and a half times the output rate, for the whole request.
 */
function listed(input: number, output: number, limits: { contextTokens?: number; maxOutputTokens?: number } = {}): CatalogModel {
  const micros = (dollars: number) => Math.round(dollars * 1_000_000);
  return Object.freeze({
    pricing: Object.freeze({
      inputMicrosPerMillionTokens: micros(input), outputMicrosPerMillionTokens: micros(output),
      longContext: Object.freeze({ aboveInputTokens: 272_000, inputMicrosPerMillionTokens: micros(input * 2), outputMicrosPerMillionTokens: micros(output * 1.5) }),
    }),
    ...limits,
  });
}

/**
 * OpenAI's standard list prices on the date below, from https://developers.openai.com/api/docs/pricing, used only when
 * a registry opts in with `prices: 'catalog'`. Prices change: check the date, and give your own prices when they
 * matter.
 *
 * Conservative by design, so a budget never undercounts: cached input is charged at the full input rate, and the
 * long-context rule is applied to every model here, including ones where OpenAI's pages don't say whether it applies.
 * Promotional prices are left out, because they rise when the promotion ends.
 */
export const catalog: ModelCatalog = Object.freeze({
  asOf: '2026-09-29',
  models: Object.freeze({
    'gpt-6-astra': listed(10, 50, { contextTokens: 1_050_000, maxOutputTokens: 128_000 }),
    'gpt-6-sol': listed(2, 10, { contextTokens: 1_050_000, maxOutputTokens: 128_000 }),
    'gpt-6-luna': listed(0.1, 0.5, { contextTokens: 1_050_000, maxOutputTokens: 128_000 }),
    'gpt-5.5': listed(5, 30, { contextTokens: 1_050_000, maxOutputTokens: 128_000 }),
    'gpt-5-mini': listed(0.25, 2, { contextTokens: 400_000, maxOutputTokens: 128_000 }),
    'gpt-5-nano': listed(0.05, 0.4),
    'gpt-4.1': listed(2, 8),
  }),
});
