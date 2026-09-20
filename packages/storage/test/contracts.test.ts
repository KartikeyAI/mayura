import { describe, expect, it } from 'vitest';
import { StorageError as AdapterError, storageError as adapterError } from '@mayura/storage';
import { StorageError, storageError } from '@mayura/storage-contracts';

describe('driver-free storage contract compatibility', () => {
  it('re-exports one exact error constructor and sanitizer rather than duplicating identity', () => {
    expect(AdapterError).toBe(StorageError);
    expect(adapterError).toBe(storageError);
    const conflict = new StorageError('CONFLICT', 'Safe fixture conflict.');
    expect(conflict).toBeInstanceOf(AdapterError);
    expect(adapterError(conflict)).toBe(conflict);
    expect(storageError(new AdapterError('STALE_CLAIM', 'Safe stale fixture.'))).toBeInstanceOf(StorageError);
  });

  it('keeps unknown driver diagnostics outside the shared public error contract', () => {
    const converted = storageError(new Error('PRIVATE_CONNECTION_CREDENTIALS'));
    expect(converted.code).toBe('STORAGE_UNAVAILABLE');
    expect(converted.message).not.toContain('PRIVATE');
    expect(converted).toBeInstanceOf(AdapterError);
  });
});
