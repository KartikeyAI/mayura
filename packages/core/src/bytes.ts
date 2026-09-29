/**
 * Hashing and byte helpers that run on every supported runtime: Node, Bun, Deno, Cloudflare Workers and Vercel Edge.
 * They replace `node:crypto` and the global `Buffer`, which edge runtimes lack. Where the runtime provides Node's
 * crypto module (`process.getBuiltinModule`), hashing uses it; elsewhere a synchronous SHA-256 in JavaScript produces
 * the same digest. Durable records hold these digests, so both paths must always agree.
 */
import { MayuraError } from './errors.js';

type NativeHash = { update(data: string | Uint8Array, encoding?: 'utf8'): NativeHash; digest(): Uint8Array };

const nativeCreateHash = ((): ((algorithm: 'sha256') => NativeHash) | undefined => {
  try {
    const host = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const crypto = typeof host?.getBuiltinModule === 'function' ? host.getBuiltinModule('node:crypto') as { createHash?: (algorithm: string) => NativeHash } | undefined : undefined;
    return typeof crypto?.createHash === 'function' ? algorithm => crypto.createHash!(algorithm) : undefined;
  } catch { return undefined; }
})();

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string => { let text = ''; for (const byte of bytes) text += byte.toString(16).padStart(2, '0'); return text; };

/** SHA-256 of UTF-8 text or bytes. */
export function sha256(input: string | Uint8Array): Uint8Array {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new MayuraError('INVALID_INPUT', 'SHA-256 input must be text or bytes.');
  if (nativeCreateHash) return new Uint8Array(nativeCreateHash('sha256').update(input, typeof input === 'string' ? 'utf8' : undefined).digest());
  return portableSha256(typeof input === 'string' ? encoder.encode(input) : input);
}

/** SHA-256 of UTF-8 text or bytes, as 64 lowercase hex characters. */
export function sha256Hex(input: string | Uint8Array): string { return hex(sha256(input)); }

/** The number of bytes in the UTF-8 encoding of `text`; a lone surrogate counts as U+FFFD, as in `Buffer.byteLength`. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

/** Unpadded base64url of UTF-8 text or bytes, as `Buffer#toString('base64url')` writes it. */
export function toBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32_768) binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Bytes of base64url text (padding optional), or undefined when the text is not base64url. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/u.test(text)) return undefined;
  const bare = text.replace(/=+$/u, '');
  if (bare.length % 4 === 1) return undefined;
  const binary = atob(bare.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(bare.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const rounds = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** @internal SHA-256 (FIPS 180-4) in JavaScript, used where Node's crypto module is unavailable. Exported for tests. */
export function portableSha256(message: Uint8Array): Uint8Array {
  const length = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(length); padded.set(message); padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Math.floor(message.length / 0x20000000)); view.setUint32(length - 4, (message.length << 3) >>> 0);
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const low = words[index - 15]!; const high = words[index - 2]!;
      const s0 = rotate(low, 7) ^ rotate(low, 18) ^ (low >>> 3); const s1 = rotate(high, 17) ^ rotate(high, 19) ^ (high >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state as unknown as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + rounds[index]! + words[index]!) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0; state[1] = (state[1]! + b) >>> 0; state[2] = (state[2]! + c) >>> 0; state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0; state[5] = (state[5]! + f) >>> 0; state[6] = (state[6]! + g) >>> 0; state[7] = (state[7]! + h) >>> 0;
  }
  const digest = new Uint8Array(32); const out = new DataView(digest.buffer);
  for (let index = 0; index < 8; index++) out.setUint32(index * 4, state[index]!);
  return digest;
}
