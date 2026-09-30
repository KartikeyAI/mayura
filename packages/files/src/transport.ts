import { MayuraError } from '@mayura/core';
import { FileStoreError, fileHttpFailure } from './contracts.js';

/** For HTTP backends: a non-2xx response as its failure, without reading the provider's text. */
export function fileResponseFailure(response: Response): MayuraError {
  void response.body?.cancel().catch(() => undefined);
  return fileHttpFailure(response.status);
}

/**
 * For HTTP backends: a response's body, refused with `LIMIT_EXCEEDED` when it is larger than `maxBytes`: by its
 * Content-Length before reading, or while reading when it has none or it is wrong.
 */
export async function fileBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && !/^\d{1,16}$/u.test(length)) { void response.body?.cancel().catch(() => undefined); throw new FileStoreError('invalid_response'); }
  if (length !== null && Number(length) > maxBytes) { void response.body?.cancel().catch(() => undefined); throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`); }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (chunks.length === 1) return chunks[0]!;
  const data = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}
