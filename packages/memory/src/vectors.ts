import { createHash } from 'node:crypto';
import { MayuraError } from '@mayura/core';

/** A local or authorized hosted embedding adapter. Mayura never sends restricted records to it. */
export interface MemoryEmbedder {
  /** Stable identity; vectors are keyed by it, so changing the model means a new id. */
  readonly id: string;
  readonly dimensions: number;
  /** Largest batch one `embed` call accepts. */
  readonly maxBatch: number;
  /** Whether content leaves the process. Hosted embedders only receive the `embedSensitivities` profile. */
  readonly location: 'local' | 'hosted';
  embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]>;
}

const token = /[\p{L}\p{N}_-]+/gu;
/** Lower-cased word tokens, shared by the lexical index and the hashing embedder. */
export function tokens(text: string): string[] { return text.toLowerCase().match(token) ?? []; }

/**
 * Local, deterministic, network-free feature-hashing embedder over word unigrams and bigrams.
 * It captures lexical overlap, not meaning; use it for tests, offline fallback and development.
 */
export function hashingEmbedder(options: { readonly dimensions?: number } = {}): MemoryEmbedder {
  const dimensions = options.dimensions ?? 256;
  if (!Number.isSafeInteger(dimensions) || dimensions < 8 || dimensions > 4_096) throw new MayuraError('INVALID_CONFIG', 'Hashing embedder dimensions must be 8–4096.');
  const bucket = (feature: string): [number, number] => {
    const digest = createHash('sha256').update(feature).digest();
    return [digest.readUInt32LE(0) % dimensions, (digest[4]! & 1) === 0 ? 1 : -1];
  };
  return Object.freeze({
    id: `mayura.hashing-v1.${dimensions}`, dimensions, maxBatch: 256, location: 'local' as const,
    embed: async (texts: readonly string[]) => texts.map(text => {
      const vector = new Array<number>(dimensions).fill(0); const words = tokens(text);
      const features = [...words, ...words.slice(1).map((word, index) => `${words[index]} ${word}`)];
      for (const feature of features) { const [index, sign] = bucket(feature); vector[index]! += sign; }
      return normalize(vector);
    }),
  });
}

export function normalize(vector: readonly number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm === 0 ? [...vector] : vector.map(value => value / norm);
}
export function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let sum = 0; for (let index = 0; index < left.length; index++) sum += left[index]! * right[index]!; return sum;
}

/** Little-endian Float32 base64: portable across SQLite text, PostgreSQL text and worker IPC. */
export function encodeVector(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString('base64');
}
export function decodeVector(value: string, dimensions: number): Float32Array {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== dimensions * 4) throw new MayuraError('STORAGE_UNAVAILABLE', 'A stored memory vector has the wrong dimensions.');
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index++) vector[index] = bytes.readFloatLE(index * 4);
  return vector;
}

/** Validate an adapter's output: exact count and dimensions, finite values, then unit-normalize. */
export function admitEmbeddings(raw: unknown, count: number, dimensions: number): number[][] {
  if (!Array.isArray(raw) || raw.length !== count) throw new MayuraError('INVALID_OUTPUT', 'The embedder returned the wrong number of vectors.');
  return raw.map(vector => {
    if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new MayuraError('INVALID_OUTPUT', 'The embedder returned an invalid vector.');
    }
    return normalize(vector as number[]);
  });
}

/** Deterministic PRNG so index training is reproducible for the same corpus. */
function prng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4_294_967_296; };
}

/** k-means++ seeding and Lloyd iterations over unit vectors (spherical k-means). Returns unit centroids. */
export function trainCentroids(sample: readonly Float32Array[], lists: number, options: { readonly iterations?: number; readonly seed?: number } = {}): Float32Array[] {
  if (sample.length === 0 || lists < 1) return [];
  const k = Math.min(lists, sample.length); const random = prng(options.seed ?? 0x6d617975); const dimensions = sample[0]!.length;
  const centroids: Float32Array[] = [sample[Math.floor(random() * sample.length)]!];
  const distance = new Float64Array(sample.length).fill(Infinity);
  while (centroids.length < k) {
    const latest = centroids.at(-1)!; let total = 0;
    for (let index = 0; index < sample.length; index++) { distance[index] = Math.min(distance[index]!, Math.max(0, 1 - dot(sample[index]!, latest))); total += distance[index]!; }
    if (total === 0) break;
    let target = random() * total; let chosen = sample.length - 1;
    for (let index = 0; index < sample.length; index++) { target -= distance[index]!; if (target <= 0) { chosen = index; break; } }
    centroids.push(sample[chosen]!);
  }
  let current = centroids.map(centroid => Float32Array.from(centroid));
  for (let iteration = 0; iteration < (options.iterations ?? 12); iteration++) {
    const sums = current.map(() => new Float64Array(dimensions)); const counts = new Array<number>(current.length).fill(0);
    for (const vector of sample) {
      const list = nearestCentroids(vector, current, 1)[0]!; counts[list]!++;
      const sum = sums[list]!; for (let index = 0; index < dimensions; index++) sum[index]! += vector[index]!;
    }
    current = current.map((centroid, list) => {
      if (counts[list] === 0) return centroid;
      const norm = Math.hypot(...sums[list]!); return norm === 0 ? centroid : Float32Array.from(sums[list]!, value => value / norm);
    });
  }
  return current;
}

/** Indexes of the `count` centroids most similar to the vector, best first. */
export function nearestCentroids(vector: ArrayLike<number>, centroids: readonly ArrayLike<number>[], count: number): number[] {
  return centroids.map((centroid, index) => ({ index, score: dot(vector, centroid) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, count).map(entry => entry.index);
}

/** Okapi BM25 over pre-counted term frequencies. */
export function bm25(options: {
  readonly frequencies: ReadonlyMap<string, number>; readonly length: number; readonly averageLength: number;
  readonly documentFrequency: ReadonlyMap<string, number>; readonly documents: number; readonly terms: readonly string[];
}): number {
  const k1 = 1.2; const b = 0.75; let score = 0;
  for (const term of options.terms) {
    const frequency = options.frequencies.get(term) ?? 0; if (frequency === 0) continue;
    const df = options.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (options.documents - df + 0.5) / (df + 0.5));
    score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * options.length / Math.max(1, options.averageLength)));
  }
  return score;
}

/** Reciprocal-rank fusion of ranked id lists. */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
