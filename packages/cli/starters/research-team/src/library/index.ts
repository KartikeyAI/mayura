import { defineTool, z } from 'mayura';
import { jsonSchema } from '../model.js';

/** Source ids are what reports cite, so they are short, stable and never free text. */
export const sourceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);

export interface SourceDocument { readonly id: string; readonly title: string; readonly published: string; readonly text: string }
export interface SearchHit { readonly id: string; readonly title: string; readonly snippet: string; readonly score: number }

/**
 * Where researchers look things up. The starter ships an in-memory keyword index over a bundled corpus; swap in web
 * search, a vector store or your document system by implementing these two methods (see README "Make it yours").
 * Whatever you plug in, `read` is the source of truth for citations: a report may only cite ids `read` returns.
 */
export interface SourceLibrary {
  search(query: string, options: { readonly limit: number }): Promise<readonly SearchHit[]>;
  read(id: string): Promise<SourceDocument | undefined>;
}

// ---- Local keyword index ----------------------------------------------------------------------------------------------

const stopWords = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do', 'does', 'for', 'from', 'has', 'have', 'how',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'them', 'there', 'they', 'this', 'to', 'was',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'about', 'much', 'many', 'does', 'into', 'than']);
const suffixes = ['ership', 'ations', 'ances', 'ences', 'ments', 'ation', 'ance', 'ence', 'ment', 'ings', 'ing', 'ers', 'ed', 'er', 'es', 's'];

/** A deliberately small stemmer: enough for "owns", "owned" and "ownership" to meet, not a linguistic model. */
function stem(word: string): string {
  for (const suffix of suffixes) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) { word = word.slice(0, -suffix.length); break; }
  }
  if (word.length > 3 && word.endsWith('y')) return `${word.slice(0, -1)}i`;
  return word.length > 3 && word.endsWith('e') ? word.slice(0, -1) : word;
}

/** Lower-cased, stemmed content words of a text. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter(word => word.length > 1 && !stopWords.has(word)).map(stem);
}

/** Sentences of a document, one per line in the bundled corpus. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).map(sentence => sentence.trim()).filter(Boolean);
}

/**
 * An in-memory library over fixed documents. Ranking counts the query terms a document shares, each weighted by how
 * rare it is in the library (a word every document uses, like "microgrid" here, weighs nothing); title matches count
 * again. The snippet is the document's best-scoring sentence.
 */
export function localLibrary(documents: readonly SourceDocument[]): SourceLibrary {
  const byId = new Map(documents.map(document => [document.id, document]));
  const frequency = new Map<string, number>();
  for (const document of documents) for (const term of new Set(terms(`${document.title} ${document.text}`))) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const weight = (term: string): number => Math.round(10 * Math.log(documents.length / (frequency.get(term) ?? documents.length)));
  const score = (wanted: readonly string[], text: string): number => { const present = new Set(terms(text));
    return wanted.filter(term => present.has(term)).reduce((sum, term) => sum + weight(term), 0); };
  return {
    async search(query, { limit }) {
      const wanted = [...new Set(terms(query))];
      if (wanted.length === 0) return [];
      return documents
        .map(document => {
          const total = score(wanted, document.text) + score(wanted, document.title);
          const best = sentences(document.text).map(sentence => ({ sentence, score: score(wanted, sentence) }))
            .reduce((top, candidate) => candidate.score > top.score ? candidate : top, { sentence: '', score: -1 });
          return { id: document.id, title: document.title, snippet: best.sentence.slice(0, 240), score: total };
        })
        .filter(hit => hit.score > 0)
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
        .slice(0, limit);
    },
    async read(id) { return byId.get(id); },
  };
}

// ---- Tools ------------------------------------------------------------------------------------------------------------

const searchInput = z.strictObject({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(5) });
const searchOutput = z.strictObject({ hits: z.array(z.strictObject({ id: sourceId, title: z.string().max(200), snippet: z.string().max(240),
  score: z.number().int().min(0) })).max(5) });
const readInput = z.strictObject({ id: sourceId });
export const readOutput = z.strictObject({ id: sourceId, title: z.string().max(200), published: z.string().max(32), text: z.string().max(8_000) });

/**
 * The researcher's tools. `onRead` lets the calling workflow step record which documents were actually read, so it
 * can refuse findings that cite anything else. Both tools only read.
 */
export function libraryTools(library: SourceLibrary, onRead: (id: string) => void = () => {}) {
  const search = defineTool({
    id: 'library.search', version: '1', effects: 'read', capabilities: ['library:read'],
    description: 'Keyword search over the source library. Returns up to `limit` document ids, titles and one matching sentence each.',
    input: searchInput, inputJsonSchema: jsonSchema(searchInput), output: searchOutput,
    execute: async ({ query, limit }) => ({ hits: (await library.search(query, { limit })).map(hit => ({ ...hit, title: hit.title.slice(0, 200), snippet: hit.snippet.slice(0, 240) })) }),
  });
  const read = defineTool({
    id: 'library.read', version: '1', effects: 'read', capabilities: ['library:read'],
    description: 'Read one library document by its id. Cite documents only by the ids this tool returned.',
    input: readInput, inputJsonSchema: jsonSchema(readInput), output: readOutput,
    execute: async ({ id }) => {
      const document = await library.read(id);
      if (!document) throw new Error('No such document.');
      onRead(document.id);
      return { id: document.id, title: document.title.slice(0, 200), published: document.published.slice(0, 32), text: document.text.slice(0, 8_000) };
    },
  });
  return { search, read, tools: [search, read], permissions: ['tool:library.search', 'tool:library.read', 'library:read', 'effect:read'] } as const;
}
