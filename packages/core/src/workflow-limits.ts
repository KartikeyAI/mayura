import { MayuraError } from './errors.js';

/** Admission default for workflow graphs that do not explicitly opt into a larger bound. */
export const DEFAULT_WORKFLOW_MAX_NODES = 128;
/** Ceiling for finite per-graph bounds; byte, call, concurrency and tree-wide limits remain independent. */
export const MAX_WORKFLOW_NODES = 512;

/** Validate without coercion. False disables node-count admission; Infinity is comparison-only, never persisted. */
export function workflowNodeLimit(value: unknown = undefined): number {
  if (value === undefined) return DEFAULT_WORKFLOW_MAX_NODES;
  if (value === false) return Infinity;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_WORKFLOW_NODES) {
    throw new MayuraError('INVALID_CONFIG', `maxNodes must be false or an integer from 1 through ${MAX_WORKFLOW_NODES}.`);
  }
  return value;
}
