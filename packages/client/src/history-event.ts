/** Exact metadata-only history schema shared by wire and headless admission. No content is retained. */
export function validHistoryEvent(metadata: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(metadata).length === 4 && ['entries', 'omitted', 'bytes', 'scanTruncated'].every(key => Object.hasOwn(metadata, key))
    && typeof metadata['entries'] === 'number' && Number.isSafeInteger(metadata['entries']) && metadata['entries'] >= 0 && metadata['entries'] <= 2048
    && typeof metadata['omitted'] === 'number' && Number.isSafeInteger(metadata['omitted']) && metadata['omitted'] >= 0
    && typeof metadata['bytes'] === 'number' && Number.isSafeInteger(metadata['bytes']) && metadata['bytes'] >= 2
    && (metadata['entries'] !== 0 || metadata['bytes'] === 2) && typeof metadata['scanTruncated'] === 'boolean';
}
