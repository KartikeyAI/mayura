import { jsonValue, MayuraError, type Guard, type JsonValue } from '@mayura/core';
import { boundedText, type ContentProcessor, type ContentSnapshot } from './pipeline.js';

/** Preserve only content and assign user authority locally; untrusted role/tool metadata is discarded. */
export function normalizeUserMessage(): ContentProcessor {
  return Object.freeze({ id: 'native.normalize-user-message', version: '1', process: (snapshot: ContentSnapshot) => {
    const input = snapshot.value;
    if (typeof input === 'string') return { role: 'user', content: input };
    if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'content')) return { role: 'user', content: input['content']! };
    throw new MayuraError('INVALID_INPUT', 'A user message must be text or a content envelope.');
  } });
}

export interface RedactPIIOptions {
  readonly email?: boolean;
  readonly phone?: boolean;
  readonly emailReplacement?: string;
  readonly phoneReplacement?: string;
}

/** Heuristic string-value redaction, not complete PII detection or compliance certification. */
export function redactPII(options: RedactPIIOptions = {}): ContentProcessor {
  const email = options.email ?? true; const phone = options.phone ?? false;
  if (typeof email !== 'boolean' || typeof phone !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'PII recognizers must be explicitly enabled or disabled.');
  const emailReplacement = options.emailReplacement ?? '[EMAIL]'; const phoneReplacement = options.phoneReplacement ?? '[PHONE]';
  boundedText(emailReplacement, 'emailReplacement', 128); boundedText(phoneReplacement, 'phoneReplacement', 128);
  const redactString = (value: string): string => {
    // Bounded spans avoid input-driven unbounded regex backtracking on punctuation-heavy text.
    let result = email ? value.replace(/\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}\b/gi, () => emailReplacement) : value;
    if (phone) result = result.replace(/(?<![\w])\+?\d[\d ()-]{6,48}\d(?![\w])/g, (match) => {
      const digits = match.replace(/\D/g, '').length;
      return digits >= 10 && digits <= 15 ? phoneReplacement : match;
    });
    return result;
  };
  const visit = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    return value;
  };
  return Object.freeze({ id: 'native.redact-pii', version: '1', process: (snapshot: ContentSnapshot) => visit(snapshot.value) });
}

export interface ProtectLiteralsOptions { readonly literals: readonly string[]; readonly caseSensitive?: boolean; readonly id?: string }

/** Blocks configured literal substrings only; this is not a semantic prompt-injection detector. */
export function protectLiterals(options: ProtectLiteralsOptions): Guard {
  if (!Array.isArray(options.literals) || options.literals.length === 0 || options.literals.length > 128) throw new MayuraError('INVALID_CONFIG', 'One to 128 bounded protected literals are required.');
  const caseSensitive = options.caseSensitive ?? true;
  if (typeof caseSensitive !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'caseSensitive must be a boolean.');
  const normalize = (value: string): string => caseSensitive ? value : value.toLowerCase();
  const literals = Object.freeze(options.literals.map((literal) => { boundedText(literal, 'protected literal', 4_096); return normalize(literal); }));
  const id = options.id ?? 'native.protect-literals'; boundedText(id, 'guard.id', 128);
  const matches = (value: string): boolean => { const candidate = normalize(value); return literals.some((literal) => candidate.includes(literal)); };
  const contains = (value: JsonValue): boolean => {
    if (typeof value === 'string') return matches(value);
    if (Array.isArray(value)) return value.some(contains);
    if (value && typeof value === 'object') return Object.entries(value).some(([key, child]) => matches(key) || contains(child));
    return false;
  };
  return Object.freeze({ id, check: (value: JsonValue) => {
    // Standalone use still validates its boundary rather than inspecting getters or exotic values.
    const safe = jsonValue(value);
    return { decision: contains(safe) ? 'block' as const : 'allow' as const };
  } });
}
