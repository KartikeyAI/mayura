/** Small seeded PRNG (mulberry32) for reproducible property tests without a test-only dependency. */
export interface Random {
  next(): number;
  int(bound: number): number;
  chance(probability: number): boolean;
  pick<T>(values: readonly T[]): T;
  shuffle<T>(values: readonly T[]): T[];
}
export function prng(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (bound: number): number => Math.floor(next() * bound);
  return {
    next, int, chance: probability => next() < probability,
    pick: values => values[int(values.length)]!,
    shuffle: values => { const copy = [...values]; for (let index = copy.length - 1; index > 0; index--) { const other = int(index + 1); [copy[index], copy[other]] = [copy[other]!, copy[index]!]; } return copy; },
  };
}
