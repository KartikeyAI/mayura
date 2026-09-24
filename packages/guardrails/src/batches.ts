import { assertPositiveInteger, MayuraError, type GuardContext } from '@mayura/core';
import { assertPipeline, Deadline, snapshotContext, type GuardedContent, type Pipeline } from './pipeline.js';

export interface BatchOptions {
  readonly maxChunksPerBatch?: number;
  readonly maxBatchBytes?: number;
  readonly maxBatches?: number;
  readonly maxDurationMs?: number;
}

export interface BufferedOutputOptions {
  readonly maxChunks?: number;
  readonly maxBytes?: number;
  readonly maxDurationMs?: number;
}

/** Release only independently admitted text batches. Earlier releases cannot be retracted by later verdicts. */
export async function* releaseBatches(
  source: AsyncIterable<string>, pipeline: Pipeline, supplied: GuardContext, options: BatchOptions = {},
): AsyncIterable<GuardedContent> {
  const maxChunksPerBatch = options.maxChunksPerBatch ?? 16;
  const maxBatchBytes = options.maxBatchBytes ?? 65_536;
  const maxBatches = options.maxBatches ?? 128;
  const maxDurationMs = options.maxDurationMs ?? 30_000;
  for (const [name, value] of Object.entries({ maxChunksPerBatch, maxBatchBytes, maxBatches, maxDurationMs })) assertPositiveInteger(value, name);
  if (maxChunksPerBatch > 256 || maxDurationMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'Batch limits exceed supported bounds.');
  assertPipeline(pipeline);
  const original = snapshotContext(supplied);
  if (original.boundary !== 'output') throw new MayuraError('INVALID_CONFIG', 'Batch release requires an output boundary context.');
  const deadline = new Deadline(original.signal, maxDurationMs);
  const context = snapshotContext(original, deadline.controller.signal);
  let iterator: AsyncIterator<string>;
  try {
    if (context.signal.aborted) await deadline.run(() => undefined);
    iterator = source[Symbol.asyncIterator]();
  }
  catch {
    deadline.close();
    if (original.signal.aborted) throw new MayuraError('CANCELLED', 'The output stream was cancelled.');
    throw new MayuraError('INVALID_OUTPUT', 'The output source could not be initialized.');
  }
  const encoder = new TextEncoder();
  let chunks: string[] = []; let bytes = 0; let released = 0;
  const admit = async (): Promise<GuardedContent> => {
    if (released >= maxBatches) throw new MayuraError('LIMIT_EXCEEDED', 'The output batch limit was reached.');
    const candidate = chunks.join(''); chunks = []; bytes = 0;
    const outcome = await deadline.run(() => pipeline.process(candidate, context));
    if (outcome.status !== 'succeeded') throw new MayuraError(outcome.error.code, 'An output batch was withheld by its content boundary.');
    released++;
    return outcome.output;
  };
  try {
    for (;;) {
      const next = await deadline.run(async () => {
        try {
          const entry = await iterator.next();
          const done = entry.done;
          if (done !== undefined && typeof done !== 'boolean') throw new Error();
          const value = done ? '' : entry.value;
          if (typeof value !== 'string') throw new Error();
          return { done: done === true, value };
        }
        catch { throw new MayuraError('INVALID_OUTPUT', 'The output source could not provide a valid batch.'); }
      });
      if (next.done) break;
      if (typeof next.value !== 'string') throw new MayuraError('INVALID_OUTPUT', 'The output source must provide text chunks.');
      const size = encoder.encode(next.value).length;
      if (size > maxBatchBytes) throw new MayuraError('LIMIT_EXCEEDED', 'An output chunk exceeds the batch byte limit.');
      if (chunks.length > 0 && bytes + size > maxBatchBytes) yield await admit();
      chunks.push(next.value); bytes += size;
      if (chunks.length >= maxChunksPerBatch) yield await admit();
    }
    if (chunks.length > 0) yield await admit();
  } finally {
    deadline.close();
    // Cleanup is cooperative; do not let an uncooperative iterator's return promise hang cancellation.
    try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* The content boundary is already closed. */ }
  }
}

/** Buffer one bounded transcript and release it only after a whole-output pipeline decision. */
export async function releaseBufferedOutput(
  source: AsyncIterable<string>, pipeline: Pipeline, supplied: GuardContext, options: BufferedOutputOptions = {},
): Promise<GuardedContent> {
  const maxChunks = options.maxChunks ?? 4_096;
  const maxBytes = options.maxBytes ?? 1_048_576;
  const maxDurationMs = options.maxDurationMs ?? 30_000;
  for (const [name, value] of Object.entries({ maxChunks, maxBytes, maxDurationMs })) assertPositiveInteger(value, name);
  if (maxChunks > 65_536 || maxBytes > 16 * 1_048_576 || maxDurationMs > 2_147_483_647) {
    throw new MayuraError('INVALID_CONFIG', 'Buffered output limits exceed supported bounds.');
  }
  assertPipeline(pipeline);
  const original = snapshotContext(supplied);
  if (original.boundary !== 'output') throw new MayuraError('INVALID_CONFIG', 'Buffered release requires an output boundary context.');
  const deadline = new Deadline(original.signal, maxDurationMs);
  const context = snapshotContext(original, deadline.controller.signal);
  let iterator: AsyncIterator<string> | undefined;
  try {
    if (context.signal.aborted) await deadline.run(() => undefined);
    try { iterator = source[Symbol.asyncIterator](); }
    catch {
      if (original.signal.aborted) throw new MayuraError('CANCELLED', 'The output stream was cancelled.');
      throw new MayuraError('INVALID_OUTPUT', 'The output source could not be initialized.');
    }
    const encoder = new TextEncoder(); const chunks: string[] = []; let bytes = 0;
    for (;;) {
      const next = await deadline.run(async () => {
        try {
          const entry = await iterator!.next();
          const done = entry.done;
          if (done !== undefined && typeof done !== 'boolean') throw new Error();
          const value = done ? '' : entry.value;
          if (typeof value !== 'string') throw new Error();
          return { done: done === true, value };
        } catch { throw new MayuraError('INVALID_OUTPUT', 'The output source could not provide valid text.'); }
      });
      if (next.done) break;
      if (chunks.length >= maxChunks) throw new MayuraError('LIMIT_EXCEEDED', 'The buffered output chunk limit was reached.');
      const size = encoder.encode(next.value).length;
      if (size > maxBytes - bytes) throw new MayuraError('LIMIT_EXCEEDED', 'The buffered output byte limit was reached.');
      chunks.push(next.value); bytes += size;
    }
    const outcome = await deadline.run(() => pipeline.process(chunks.join(''), context));
    if (outcome.status !== 'succeeded') throw new MayuraError(outcome.error.code, 'The complete output was withheld by its content boundary.');
    return outcome.output;
  } finally {
    deadline.close();
    try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* The content boundary is already closed. */ }
  }
}
