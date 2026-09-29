import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { fromBase64Url, portableSha256, sha256, sha256Hex, toBase64Url, utf8ByteLength } from '../src/bytes.js';

// Durable records hold these digests and encodings, so they must match what node:crypto and Buffer produced before.
const nodeHex = (input: string | Uint8Array): string => createHash('sha256').update(input).digest('hex');
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const text = fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' }), fc.string({ unit: fc.integer({ min: 0xd800, max: 0xdfff }).map(code => String.fromCharCode(code)) }));
const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(1_000), 'Grüße, 世界 🌏', '\ud800', 'x\udc00y', '\ud83c'];

describe('portable bytes', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('hashes text and bytes exactly as node:crypto does, natively and in JavaScript', () => {
    for (const sample of samples) {
      expect(sha256Hex(sample)).toBe(nodeHex(sample));
      expect(hex(portableSha256(new TextEncoder().encode(sample)))).toBe(nodeHex(sample));
    }
    fc.assert(fc.property(text, value => sha256Hex(value) === nodeHex(value) && hex(portableSha256(new TextEncoder().encode(value))) === nodeHex(value)));
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), bytes => sha256Hex(bytes) === nodeHex(bytes) && hex(sha256(bytes)) === nodeHex(bytes)));
  });

  it('falls back to the JavaScript digest where the runtime has no Node crypto module', async () => {
    vi.stubGlobal('process', { ...process, getBuiltinModule: undefined });
    vi.resetModules();
    const portable = await import('../src/bytes.js');
    for (const sample of samples) expect(portable.sha256Hex(sample)).toBe(nodeHex(sample));
    expect(portable.sha256Hex(new Uint8Array([0, 255, 7]))).toBe(nodeHex(new Uint8Array([0, 255, 7])));
  });

  it('counts UTF-8 bytes as Buffer.byteLength does, lone surrogates included', () => {
    for (const sample of samples) expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample));
    fc.assert(fc.property(text, value => utf8ByteLength(value) === Buffer.byteLength(value)));
  });

  it('writes base64url as Buffer does and reads back what Buffer wrote', () => {
    fc.assert(fc.property(text, value => {
      const encoded = toBase64Url(value);
      return encoded === Buffer.from(value).toString('base64url') && Buffer.from(fromBase64Url(encoded)!).equals(Buffer.from(value));
    }));
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), bytes => toBase64Url(bytes) === Buffer.from(bytes).toString('base64url')
      && Buffer.from(fromBase64Url(Buffer.from(bytes).toString('base64url'))!).equals(Buffer.from(bytes))));
    expect(fromBase64Url('YWI=')).toEqual(new Uint8Array([97, 98]));
  });

  it('refuses text that is not base64url, and inputs that are neither text nor bytes', () => {
    for (const bad of ['a', 'ab+c', 'ab/c', 'a b', 'ab=c', '====', 'abcde']) expect(fromBase64Url(bad)).toBeUndefined();
    expect(() => sha256(7 as never)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
