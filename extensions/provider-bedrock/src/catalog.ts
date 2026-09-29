import type { CatalogModel, ModelCatalog } from 'mayura';

const micros = (dollars: number) => Math.round(dollars * 1_000_000);
/** On-demand list prices in dollars per million tokens, with the model's context and output limits. */
const listed = (input: number, output: number, contextTokens: number, maxOutputTokens: number): CatalogModel => Object.freeze({
  pricing: Object.freeze({ inputMicrosPerMillionTokens: micros(input), outputMicrosPerMillionTokens: micros(output) }), contextTokens, maxOutputTokens,
});

/**
 * Amazon Bedrock's on-demand list prices in US East (N. Virginia) on the date below, from
 * https://aws.amazon.com/bedrock/pricing/, used only when a registry opts in with `prices: 'catalog'`, and offered only by
 * a provider in us-east-1, since other regions can cost more. Prices change: check the date, and give your own prices
 * when they matter.
 *
 * Names are model ids and inference profile ids as Bedrock takes them: `global.` profiles route anywhere, `us.` ones
 * within the US at a higher price. A profile or model missing here needs your own price. Cache writes are charged at
 * twice the input rate and cache reads at the full rate, so a budget never undercounts.
 */
export const catalog: ModelCatalog = Object.freeze({
  asOf: '2026-09-29',
  models: Object.freeze({
    'global.anthropic.claude-opus-5-5': listed(4, 20, 1_000_000, 128_000),
    'us.anthropic.claude-opus-5-5': listed(4.4, 22, 1_000_000, 128_000),
    'global.anthropic.claude-sonnet-5-5': listed(2, 10, 1_000_000, 128_000),
    'us.anthropic.claude-fable-5-1': listed(11, 55, 1_000_000, 128_000),
    'global.anthropic.claude-haiku-4-5-20251001-v1:0': listed(1, 5, 200_000, 64_000),
    'us.anthropic.claude-haiku-4-5-20251001-v1:0': listed(1.1, 5.5, 200_000, 64_000),
    'global.amazon.nova-2-lite-v1:0': listed(0.3, 2.5, 1_000_000, 64_000),
    'us.amazon.nova-2-lite-v1:0': listed(0.33, 2.75, 1_000_000, 64_000),
    'amazon.nova-premier-v1:0': listed(2.5, 12.5, 1_000_000, 25_000),
    'amazon.nova-pro-v1:0': listed(0.8, 3.2, 300_000, 5_000),
    'amazon.nova-lite-v1:0': listed(0.06, 0.24, 300_000, 5_000),
    'amazon.nova-micro-v1:0': listed(0.035, 0.14, 128_000, 5_000),
    'us.meta.llama4-maverick-17b-instruct-v1:0': listed(0.24, 0.97, 1_000_000, 8_000),
    'us.meta.llama4-scout-17b-instruct-v1:0': listed(0.17, 0.66, 10_000_000, 8_000),
    'us.meta.llama3-3-70b-instruct-v1:0': listed(0.72, 0.72, 128_000, 4_000),
    'mistral.mistral-large-3-675b-instruct': listed(0.5, 1.5, 256_000, 32_000),
    'mistral.ministral-3-8b-instruct': listed(0.15, 0.15, 128_000, 8_000),
    'mistral.devstral-2-123b': listed(0.4, 2, 256_000, 32_000),
  }),
});
