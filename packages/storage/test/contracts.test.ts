import { describe, expect, it } from 'vitest';
import { StorageError as AdapterError, storageError as adapterError } from '@mayura/storage';
import { MayuraError } from '@mayura/core';
import { StorageError, isStorageError, storageError } from '@mayura/storage-contracts';

describe('driver-free storage contract compatibility', () => {
  it('re-exports one exact error constructor and sanitizer rather than duplicating identity', () => {
    expect(AdapterError).toBe(StorageError);
    expect(adapterError).toBe(storageError);
    const conflict = new StorageError('CONFLICT', 'Safe fixture conflict.');
    expect(conflict).toBeInstanceOf(AdapterError);
    expect(adapterError(conflict)).toBe(conflict);
    expect(storageError(new AdapterError('STALE_CLAIM', 'Safe stale fixture.'))).toBeInstanceOf(StorageError);
  });

  it('is a MayuraError: one catch, a general code, and the exact storage condition', () => {
    const cases = [['INVALID_INPUT', 'INVALID_INPUT'], ['CONFLICT', 'CONFLICT'], ['NOT_FOUND', 'NOT_FOUND'], ['STORAGE_UNAVAILABLE', 'STORAGE_UNAVAILABLE'],
      ['STORE_CLOSED', 'STORAGE_UNAVAILABLE'], ['STORE_NOT_INITIALIZED', 'INVALID_CONFIG'], ['QUEUE_FULL', 'LIMIT_EXCEEDED'],
      ['STALE_CLAIM', 'CONFLICT'], ['LIMIT_EXCEEDED', 'LIMIT_EXCEEDED'], ['SCHEDULED_WRITER_REQUIRED', 'CONFLICT']] as const;
    for (const [storageCode, code] of cases) {
      const error = new StorageError(storageCode, 'Safe fixture.');
      expect(error).toBeInstanceOf(MayuraError);
      expect(error).toMatchObject({ code, storageCode, message: 'Safe fixture.' });
      expect(error.toJSON()).toEqual({ code, message: 'Safe fixture.' });
      expect(isStorageError(error, storageCode)).toBe(true);
    }
    expect(isStorageError(new MayuraError('CONFLICT', 'Not storage.'), 'CONFLICT')).toBe(false);
    // A code from an unknown adapter or a newer worker degrades to unavailable storage instead of an unmapped value.
    expect(new StorageError('BOGUS' as never, 'Safe fixture.')).toMatchObject({ code: 'STORAGE_UNAVAILABLE', storageCode: 'STORAGE_UNAVAILABLE' });
  });

  it('keeps unknown driver diagnostics outside the shared public error contract', () => {
    const converted = storageError(new Error('PRIVATE_CONNECTION_CREDENTIALS'));
    expect(converted.code).toBe('STORAGE_UNAVAILABLE');
    expect(converted.message).not.toContain('PRIVATE');
    expect(converted).toBeInstanceOf(AdapterError);
  });
});
