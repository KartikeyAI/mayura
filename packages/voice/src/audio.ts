import type { Audio } from './contracts.js';

const ascii = (data: Uint8Array, offset: number) => String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!);

/**
 * The duration of WAV audio from its header: the `data` chunk's size over the `fmt` chunk's byte rate. `undefined`
 * for anything else, or a WAV whose header does not describe it.
 */
export function wavDurationMs(audio: Audio): number | undefined {
  const data = audio.data;
  if (!/^audio\/(?:wav|wave|x-wav|vnd\.wave)$/u.test(audio.mediaType) || data.byteLength < 44 || ascii(data, 0) !== 'RIFF' || ascii(data, 8) !== 'WAVE') return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let byteRate: number | undefined; let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const id = ascii(data, offset); const size = view.getUint32(offset + 4, true); const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= data.byteLength) byteRate = view.getUint32(body + 8, true);
    if (id === 'data') {
      if (!byteRate) return undefined;
      // A streamed WAV may carry a placeholder size: the bytes present are the audio.
      const bytes = Math.min(size, data.byteLength - body);
      return Math.max(1, Math.ceil((bytes * 1_000) / byteRate));
    }
    offset = body + size + (size % 2);
  }
  return undefined;
}

/** Base64 without Buffer, so it runs wherever JavaScript does. */
export function audioToBase64(data: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < data.byteLength; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
export function audioFromBase64(text: string): Uint8Array {
  const binary = atob(text); const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}
