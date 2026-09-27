/**
 * Incremental extraction of one string field from a model's streamed JSON output.
 *
 * Providers stream a structured final output as JSON text fragments. A reader wants only the human text, for example
 * the `reply` field, as it arrives. This tokenizer follows the JSON structure character by character, and when the
 * string value at `path` begins it emits that value's decoded characters (escapes and surrogate pairs resolved) as
 * they arrive. It emits only the first occurrence and stops at malformed input: the streamed view is provisional, and
 * the complete output is still parsed and validated independently before anything is final.
 */
export interface FieldExtractor {
  /** Feed the next raw fragment; returns newly decoded characters of the target field (possibly empty). */
  feed(fragment: string): string;
  /** True once the target string has closed or the input could not be followed. */
  readonly done: boolean;
}

type Frame = { kind: 'object'; key: string | null; state: 'key' | 'colon' | 'value' | 'comma' } | { kind: 'array'; index: number; state: 'value' | 'comma' };

export function createFieldExtractor(path: readonly string[], maxKeyLength = 256): FieldExtractor {
  const target = path.join('\u0000');
  const stack: Frame[] = [];
  let mode: 'value' | 'string' | 'literal' | 'end' = 'value';
  let isKey = false; let capturing = false; let key = '';
  let escape: '' | '\\' | 'u' = ''; let unicode = ''; let pendingHigh = 0;
  let finished = false;

  const currentPath = (): string => stack.map(frame => frame.kind === 'object' ? frame.key ?? '' : String(frame.index)).join('\u0000');
  const fail = (): string => { finished = true; return ''; };
  /** A value just ended: advance the enclosing container. */
  const valueEnded = (): void => {
    const top = stack.at(-1);
    if (!top) { mode = 'end'; return; }
    top.state = 'comma'; mode = 'value';
  };

  const feed = (fragment: string): string => {
    let out = '';
    for (const char of fragment) {
      if (finished) break;
      if (mode === 'string') {
        if (escape === 'u') {
          unicode += char;
          if (!/^[0-9a-fA-F]{0,4}$/u.test(unicode)) return out + fail();
          if (unicode.length < 4) continue;
          const code = Number.parseInt(unicode, 16); unicode = ''; escape = '';
          let decoded = '';
          if (code >= 0xd800 && code <= 0xdbff) { pendingHigh = code; continue; }
          if (code >= 0xdc00 && code <= 0xdfff && pendingHigh) { decoded = String.fromCharCode(pendingHigh, code); pendingHigh = 0; }
          else { pendingHigh = 0; decoded = String.fromCharCode(code); }
          if (isKey) key += decoded; else if (capturing) out += decoded;
          continue;
        }
        if (escape === '\\') {
          escape = '';
          if (char === 'u') { escape = 'u'; continue; }
          const decoded = ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[char];
          if (decoded === undefined) return out + fail();
          if (isKey) key += decoded; else if (capturing) out += decoded;
          continue;
        }
        if (char === '\\') { escape = '\\'; continue; }
        if (char === '"') {
          if (isKey) {
            const top = stack.at(-1); if (!top || top.kind !== 'object') return out + fail();
            top.key = key; top.state = 'colon'; isKey = false; mode = 'value'; continue;
          }
          if (capturing) { finished = true; break; }
          valueEnded(); continue;
        }
        if (isKey) { key += char; if (key.length > maxKeyLength) return out + fail(); }
        else if (capturing) out += char;
        continue;
      }
      if (mode === 'literal') {
        if (/[\s,\]}]/u.test(char)) { valueEnded(); /* fall through to structural handling */ }
        else continue;
      }
      if (/\s/u.test(char)) continue;
      const top = stack.at(-1);
      if (top?.kind === 'object') {
        if (top.state === 'key') {
          if (char === '"') { mode = 'string'; isKey = true; key = ''; continue; }
          if (char === '}') { stack.pop(); valueEnded(); continue; }
          return out + fail();
        }
        if (top.state === 'colon') { if (char !== ':') return out + fail(); top.state = 'value'; continue; }
        if (top.state === 'comma') {
          if (char === ',') { top.state = 'key'; top.key = null; continue; }
          if (char === '}') { stack.pop(); valueEnded(); continue; }
          return out + fail();
        }
      } else if (top?.kind === 'array' && top.state === 'comma') {
        if (char === ',') { top.index += 1; top.state = 'value'; continue; }
        if (char === ']') { stack.pop(); valueEnded(); continue; }
        return out + fail();
      } else if (top?.kind === 'array' && char === ']' && top.index === 0) { stack.pop(); valueEnded(); continue; }
      if (mode === 'end') return out + fail();
      // A value starts here.
      if (char === '{') { stack.push({ kind: 'object', key: null, state: 'key' }); continue; }
      if (char === '[') { stack.push({ kind: 'array', index: 0, state: 'value' }); continue; }
      if (char === '"') { mode = 'string'; isKey = false; capturing = currentPath() === target; continue; }
      if (/[-0-9tfn]/u.test(char)) { mode = 'literal'; continue; }
      return out + fail();
    }
    return out;
  };
  return { feed, get done() { return finished; } };
}

/**
 * Groups streamed text into batches worth checking and showing: at least `minChars` ending at whitespace, or
 * `maxChars` at most, or whatever remains at the end. Smaller batches mean more guard checks; larger ones more delay.
 */
export function createBatcher(minChars = 24, maxChars = 512): { push(text: string): string[]; flush(): string[] } {
  let buffer = '';
  const cut = (final: boolean): string[] => {
    const batches: string[] = [];
    while (buffer.length > 0) {
      if (buffer.length >= maxChars) { batches.push(buffer.slice(0, maxChars)); buffer = buffer.slice(maxChars); continue; }
      if (final) { batches.push(buffer); buffer = ''; break; }
      if (buffer.length < minChars) break;
      const boundary = Math.max(buffer.lastIndexOf(' '), buffer.lastIndexOf('\n'));
      if (boundary < minChars - 1) break;
      batches.push(buffer.slice(0, boundary + 1)); buffer = buffer.slice(boundary + 1);
      break;
    }
    return batches;
  };
  return { push: text => { buffer += text; return cut(false); }, flush: () => cut(true) };
}
