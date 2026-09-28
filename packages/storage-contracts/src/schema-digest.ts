import { jsonSchemaOf, jsonValue, MayuraError, type JsonObject, type Schema } from '@mayura/core';
import { workflowHashMaterial } from './workflow-format2.js';

const rounds = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * @internal Synchronous SHA-256 (FIPS 180-4) of UTF-8 text, as lowercase hex. This package runs without Node types or
 * WebCrypto, and definitions are built synchronously; tests check it against node:crypto.
 */
export function sha256Hex(text: string): string {
  const message = new TextEncoder().encode(text);
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
  return [...state].map(word => word.toString(16).padStart(8, '0')).join('');
}

/**
 * The SHA-256 digest (64 lowercase hex characters) that pins a schema into durable records, such as the response a
 * human request accepts or the body a webhook trigger admits. Pass a validator that can describe itself as JSON Schema
 * (Zod 4.2 and later can), or the JSON Schema object itself. The digest covers canonical JSON, so key order does not
 * change it. A validator that cannot describe itself is refused with INVALID_CONFIG.
 *
 * A derived digest follows the JSON Schema the validator produces: if a library upgrade changes that JSON Schema, the
 * digest (and a definition that contains it) changes too, like any other definition change.
 */
export function schemaDigest(schema: Schema | JsonObject): string {
  let described: JsonObject | undefined;
  if (schema !== null && typeof schema === 'object' && '~standard' in schema) {
    described = jsonSchemaOf(schema as Schema);
    if (described === undefined) {
      throw new MayuraError('INVALID_CONFIG', 'This validator cannot describe itself as JSON Schema, so its schema digest cannot be derived. '
        + 'Pass its JSON Schema object to schemaDigest, or give the 64-hex schemaDigest explicitly.');
    }
  } else {
    let copy: unknown;
    try { copy = jsonValue(schema, { maxBytes: 262_144, maxDepth: 64 }); } catch { copy = undefined; }
    if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) {
      throw new MayuraError('INVALID_CONFIG', 'schemaDigest needs a validator or a JSON Schema object of at most 256 KiB.');
    }
    described = copy as JsonObject;
  }
  return sha256Hex(workflowHashMaterial('mayura:schema-digest:v1', described));
}
