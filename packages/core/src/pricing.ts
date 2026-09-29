/** Token prices in micros (millionths of a US dollar) per million tokens. */
export interface TokenPricing {
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  /**
   * Higher rates for the whole call once its input exceeds `aboveInputTokens`, as some providers bill long prompts
   * (OpenAI bills prompts over 272K input tokens at higher rates).
   */
  readonly longContext?: {
    readonly aboveInputTokens: number;
    readonly inputMicrosPerMillionTokens: number;
    readonly outputMicrosPerMillionTokens: number;
  };
}

/**
 * What a call's tokens cost, in whole micros, rounded up: the long-context rates apply to the whole call once its input
 * exceeds their threshold. Undefined when the cost is beyond safe integers, which a caller must treat as unusable.
 */
export function tokenCostMicros(pricing: TokenPricing, inputTokens: number, outputTokens: number): number | undefined {
  const rates = pricing.longContext !== undefined && inputTokens > pricing.longContext.aboveInputTokens ? pricing.longContext : pricing;
  const cost = (BigInt(inputTokens) * BigInt(rates.inputMicrosPerMillionTokens) + BigInt(outputTokens) * BigInt(rates.outputMicrosPerMillionTokens) + 999_999n) / 1_000_000n;
  return cost > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(cost);
}
