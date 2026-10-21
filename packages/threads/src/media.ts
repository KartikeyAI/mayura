import { MEDIA_TYPES, freezeJson, jsonValue, MayuraError, type Media, type MediaType } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';

/** Durable opaque identity only: URLs, credentials and inline bytes never enter thread storage. */
export interface ThreadMediaReference {
  readonly id: string; readonly mediaType: MediaType; readonly source: 'bytes' | 'url';
  readonly bytes?: number; readonly name?: string;
}
/** Capture released/admitted media for display or a separately authorized host resolver. Never fetches content. */
export function mediaReferences(items: readonly Media[]): readonly ThreadMediaReference[] {
  if (items.length > 32) throw new MayuraError('LIMIT_EXCEEDED', 'A thread entry accepts at most 32 media references.');
  return readMediaReferences(items.map(item => ({ id: `sha256:${sha256Hex('data' in item ? item.data : item.url)}`,
    mediaType: item.mediaType, source: 'data' in item ? 'bytes' : 'url', ...('data' in item ? { bytes: item.data.byteLength } : {}),
    ...(item.name === undefined ? {} : { name: item.name }) })));
}
/** Snapshot the intentionally URL-free import format, without invoking getters or toJSON. */
export function readMediaReferences(value: unknown): readonly ThreadMediaReference[] {
  const raw = jsonValue(value, { maxBytes: 16_384, maxDepth: 2, maxNodes: 193 });
  if (!Array.isArray(raw) || raw.length > 32) throw new MayuraError('INVALID_INPUT', 'Invalid thread media references.');
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'mediaType', 'source', 'bytes', 'name'].includes(key))
      || typeof item['id'] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(item['id']) || !MEDIA_TYPES.includes(item['mediaType'] as MediaType)
      || !['bytes', 'url'].includes(String(item['source'])) || (item['source'] === 'bytes' ? !Number.isSafeInteger(item['bytes']) || (item['bytes'] as number) < 1 || (item['bytes'] as number) > 67_108_864 : item['bytes'] !== undefined)
      || (item['name'] !== undefined && (typeof item['name'] !== 'string' || !/^[^\u0000-\u001f\u007f/\\]{1,255}$/u.test(item['name'])))) throw new MayuraError('INVALID_INPUT', 'Invalid thread media reference.');
  }
  return freezeJson(raw) as unknown as readonly ThreadMediaReference[];
}
