/**
 * Document keys: a partition and a sort key, both strings compared by code point (UTF-8 byte order), which is how
 * SQLite's BINARY collation and DynamoDB order them. A key is a tuple of components, each escaped and terminated so
 * that tuples compare component by component and a tuple's prefix selects exactly its extensions.
 *
 * Encoding: U+0001 inside a component becomes U+0001 U+0003, and every component ends with U+0001 U+0001. Identifiers
 * never contain U+0000, so U+0001 U+0001 sorts below anything a component can continue with, and U+0001 U+0002 never
 * occurs in an encoded key: it bounds a prefix range from above.
 */
const ESCAPED = '\u0001\u0003';
const END = '\u0001\u0001';
const ABOVE = '\u0001\u0002';

export type KeyPart = string | number;

/** A non-negative safe integer as 16 digits, so numeric order is string order. */
export function pad(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Document key numbers are non-negative safe integers.');
  return String(value).padStart(16, '0');
}
export function key(...parts: readonly KeyPart[]): string {
  return parts.map(part => (typeof part === 'number' ? pad(part) : part).replaceAll('\u0001', ESCAPED) + END).join('');
}
/** The components of an encoded key. */
export function parts(encoded: string): string[] {
  const result: string[] = []; let current = '';
  for (let index = 0; index < encoded.length; index++) {
    const char = encoded[index]!;
    if (char !== '\u0001') { current += char; continue; }
    const next = encoded[++index];
    if (next === '\u0001') { result.push(current); current = ''; }
    else if (next === '\u0003') current += '\u0001';
    else throw new RangeError('Malformed document key.');
  }
  if (current !== '') throw new RangeError('Malformed document key.');
  return result;
}
/** The least string above every key that starts with `prefix` (an encoded tuple). */
export function above(prefix: string): string {
  if (!prefix.endsWith(END)) throw new RangeError('A key range prefix is a whole encoded tuple.');
  return prefix.slice(0, -END.length) + ABOVE;
}
/** The least string above `key` itself (every key that sorts after it, including its extensions). */
export function after(encoded: string): string { return encoded + END; }

/** Code point order, which is UTF-8 byte order; JavaScript's `<` compares UTF-16 units instead. */
export function compareKeys(left: string, right: string): number {
  const a = [...left]; const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = a[index]!.codePointAt(0)!; const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * The keys a range covers: from `lower` (inclusive) to `upper` (exclusive), and, when the range has `through`, no
 * further than it (inclusive).
 */
export function bounds(range: { readonly prefix: string; readonly after?: string; readonly through?: string }): { lower: string; upper: string; through?: string } {
  const start = range.after === undefined ? range.prefix : after(range.after);
  return { lower: compareKeys(start, range.prefix) > 0 ? start : range.prefix, upper: above(range.prefix), ...(range.through === undefined ? {} : { through: range.through }) };
}
