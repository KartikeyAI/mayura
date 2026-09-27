import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createBatcher, createFieldExtractor } from '../src/stream.js';

const run = (path: string[], fragments: string[]): string => {
  const extractor = createFieldExtractor(path); return fragments.map(fragment => extractor.feed(fragment)).join('');
};

describe('streamed field extraction', () => {
  it('emits only the target string, decoded, however the JSON is split', () => {
    const json = JSON.stringify({ references: [{ kind: 'order', id: 'ord-1' }], reply: 'Your order "ord-1" ships\ttoday é 😀.', note: 'x' });
    const expected = JSON.parse(json).reply as string;
    for (let size = 1; size <= 7; size++) {
      const fragments: string[] = []; for (let index = 0; index < json.length; index += size) fragments.push(json.slice(index, index + size));
      expect(run(['reply'], fragments)).toBe(expected);
    }
  });

  it('matches nested paths and array indexes, and only the first occurrence', () => {
    expect(run(['answer', 'text'], [JSON.stringify({ text: 'no', answer: { text: 'yes', more: 'x' } })])).toBe('yes');
    expect(run(['items', '1'], [JSON.stringify({ items: ['a', 'b', 'c'] })])).toBe('b');
    const extractor = createFieldExtractor(['reply']);
    expect(extractor.feed('{"reply":"one"')).toBe('one'); expect(extractor.done).toBe(true); expect(extractor.feed(',"reply":"two"}')).toBe('');
  });

  it('ignores keys that merely contain the target text and non-string values', () => {
    expect(run(['reply'], ['{"replyTo":"x","reply":1}'])).toBe('');
    expect(run(['reply'], ['{"a":{"reply":"inner"},"reply":"outer"}'])).toBe('outer');
  });

  it('stops quietly at malformed input instead of emitting guesses', () => {
    const extractor = createFieldExtractor(['reply']);
    expect(extractor.feed('{"reply":"ok \\q more"}')).toBe('ok '); expect(extractor.done).toBe(true);
    expect(run(['reply'], ['not json'])).toBe('');
  });

  it('agrees with JSON.parse for arbitrary objects and splits', () => {
    fc.assert(fc.property(fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 2 })), fc.string(), fc.array(fc.nat({ max: 40 }), { maxLength: 12 }),
      (extra, reply, cuts) => {
        const json = JSON.stringify({ ...extra, reply });
        const points = [...new Set(cuts.map(cut => cut % (json.length + 1)))].sort((a, b) => a - b);
        const fragments: string[] = []; let start = 0; for (const point of points) { fragments.push(json.slice(start, point)); start = point; } fragments.push(json.slice(start));
        // `reply` is last in insertion order unless `extra` also has a "reply" key; JSON.stringify keeps the spread's value.
        expect(run(['reply'], fragments)).toBe(JSON.parse(json).reply);
      }), { numRuns: 300 });
  });
});

describe('stream batching', () => {
  it('releases at word boundaries once a batch is large enough, and everything at the end', () => {
    const batcher = createBatcher(10, 40);
    expect(batcher.push('Hello')).toEqual([]);
    expect(batcher.push(' there, how are')).toEqual(['Hello there, how ']);
    expect(batcher.push(' you')).toEqual([]);
    expect(batcher.flush()).toEqual(['are you']);
  });

  it('never holds more than the maximum', () => {
    const batcher = createBatcher(10, 16);
    expect(batcher.push('x'.repeat(40))).toEqual(['x'.repeat(16), 'x'.repeat(16)]);
    expect(batcher.flush()).toEqual(['x'.repeat(8)]);
  });
});
