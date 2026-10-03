import { sha256, sha256Hex } from '@mayura/core/host';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** @internal CRC-32 (IEEE), as GitHub's token checksums use. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @internal Base62 of an unsigned integer given as bytes or a number, left-padded with zeros to `width`. */
export function base62(value: Uint8Array | number, width: number): string {
  let number = typeof value === 'number' ? BigInt(value) : value.reduce((total, byte) => (total << 8n) | BigInt(byte), 0n);
  let text = '';
  while (number > 0n) { text = alphabet[Number(number % 62n)]! + text; number /= 62n; }
  return text.padStart(width, '0');
}

/** The characters of the random part for `bytes` random bytes: enough base62 digits for every value. */
export const randomWidth = (bytes: number): number => Math.ceil((bytes * 8) / Math.log2(62));
const checksumWidth = 6;

export const prefixPattern = /^[a-z][a-z0-9]{1,15}(?:_[a-z0-9]{1,15})?$/u;

/** A new secret: `<prefix>_<random><checksum>`, the checksum a CRC-32 of the rest in six base62 characters. */
export function newSecret(prefix: string, bytes: number): string {
  const random = base62(crypto.getRandomValues(new Uint8Array(bytes)), randomWidth(bytes));
  const head = `${prefix}_${random}`;
  return `${head}${base62(crc32(head), checksumWidth)}`;
}

/** Whether `key` has this prefix's form and a checksum that matches, checked before any storage read. */
export function wellFormed(prefix: string, bytes: number, key: unknown): key is string {
  if (typeof key !== 'string' || !key.startsWith(`${prefix}_`)) return false;
  const body = key.slice(prefix.length + 1);
  if (body.length !== randomWidth(bytes) + checksumWidth || !/^[0-9A-Za-z]+$/u.test(body)) return false;
  const head = key.slice(0, key.length - checksumWidth);
  return key.slice(-checksumWidth) === base62(crc32(head), checksumWidth);
}

/** A key's stored form: the base64 of its SHA-256, which Unkey also takes when keys are migrated to it. */
export function keyHash(key: string): string {
  let binary = '';
  for (const byte of sha256(key)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** @internal The record id of a key, from its secret: hex of the same SHA-256. */
export const keyRecordId = (key: string): string => `secret.${sha256Hex(key)}`;

/** A public key id: `key_` and 22 base62 characters. */
export const newKeyId = (): string => `key_${base62(crypto.getRandomValues(new Uint8Array(16)), 22)}`;
export const keyIdPattern = /^key_[0-9A-Za-z]{22}$/u;
