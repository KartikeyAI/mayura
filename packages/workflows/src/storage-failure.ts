import { MayuraError } from '@mayura/core';
import { StorageError } from '@mayura/storage-contracts';

/** Storage conditions whose own message already tells a developer what to do. */
const actionable = new Set(['STORE_CLOSED', 'STORE_NOT_INITIALIZED', 'QUEUE_FULL']);

/**
 * @internal A storage failure as a workflow runtime reports it. A write that lost a race stays a `CONFLICT`
 * `StorageError` (the runtimes retry on it); a closed, uninitialized or saturated store keeps the store's error, whose
 * message says what to do; anything else is `STORAGE_UNAVAILABLE`, and the caller must inspect the run before
 * retrying, because the write may or may not have happened. Adapter messages of unknown errors are never reflected.
 */
export function workflowStorageFailure(error: unknown, subject: string): MayuraError {
  if (error instanceof StorageError && error.storageCode === 'CONFLICT') {
    return new StorageError('CONFLICT', `The ${subject} changed while this operation ran (another worker or request updated it). Read it again and retry.`);
  }
  if (error instanceof StorageError && actionable.has(error.storageCode)) return error;
  return new MayuraError('STORAGE_UNAVAILABLE', `The ${subject} store could not confirm this operation. Inspect the run before retrying; an action may already have happened.`);
}

/**
 * @internal A submission whose idempotency key already names a run with different content: the input, the definition
 * version or the runtime settings differ. Resubmitting the identical request returns the existing run.
 */
export function resubmissionConflict(): MayuraError {
  return new MayuraError('CONFLICT', 'This idempotency key was already used to start a run with different input, definition version or runtime settings. '
    + 'Resubmit exactly the same request to get that run, or use a new idempotency key.');
}

/** @internal Run a submission's `create`, reporting a reused idempotency key as `resubmissionConflict`. */
export async function createSubmission<T>(operation: () => Promise<T>, subject: string): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof StorageError && error.storageCode === 'CONFLICT') throw resubmissionConflict();
    throw workflowStorageFailure(error, subject);
  }
}
