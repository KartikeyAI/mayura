import type { CatalogModel, ModelCatalog } from 'mayura';

/**
 * A model's list prices in dollars per million tokens, with the long-context rule Azure applies as OpenAI does: a prompt
 * over 272K input tokens is billed at twice the input rate and one and a half times the output rate.
 */
function listed(input: number, output: number): CatalogModel {
  const micros = (dollars: number) => Math.round(dollars * 1_000_000);
  return Object.freeze({
    pricing: Object.freeze({
      inputMicrosPerMillionTokens: micros(input), outputMicrosPerMillionTokens: micros(output),
      longContext: Object.freeze({ aboveInputTokens: 272_000, inputMicrosPerMillionTokens: micros(input * 2), outputMicrosPerMillionTokens: micros(output * 1.5) }),
    }),
  });
}

/**
 * Azure OpenAI's list prices for Global deployments on the date below, from
 * https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/, by model. They reach a registry only
 * through `azure({ deployments })`, which says which model each deployment runs. Prices change: check the date.
 *
 * Conservative by design: cached input is charged at the full input rate, the long-context rule is applied to every
 * model, and models whose Azure prices were not yet published (GPT-6 Sol and Luna, on this date) are left out.
 */
export const catalog: ModelCatalog = Object.freeze({
  asOf: '2026-09-29',
  models: Object.freeze({
    'gpt-6-astra': listed(10, 50),
    'gpt-5.5': listed(5, 30),
    'gpt-5.4': listed(2.5, 15),
    'gpt-5.4-mini': listed(0.75, 4.5),
    'gpt-5-mini': listed(0.25, 2),
    'gpt-4.1': listed(2, 8),
  }),
});
