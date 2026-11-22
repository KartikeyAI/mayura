import { MayuraError } from './errors.js';

/**
 * Read one explicit host-owned environment map; never discovers process.env or
 * changes a definition that has already been admitted. Spread the result into a
 * workflow definition so the override is hashed and persisted for other workers.
 */
export function workflowNodeLimitsFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<{ maxNodes?: false }> {
  const value = environment['MAYURA_WORKFLOW_DISABLE_MAX_NODES'];
  if (value === undefined || value === '' || value === 'false' || value === '0') return Object.freeze({});
  if (value === 'true' || value === '1') return Object.freeze({ maxNodes: false });
  throw new MayuraError('INVALID_CONFIG', 'MAYURA_WORKFLOW_DISABLE_MAX_NODES must be true, false, 1 or 0.');
}
