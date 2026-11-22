/**
 * Browser-only mirror of the core graph-size wire contract. Parity tests pin both
 * validators together without adding a privileged runtime dependency to the client.
 */
export function workflowNodeLimit(value: unknown = undefined): number {
  if (value === undefined) return 128;
  if (value === false) return Infinity;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 512) {
    throw new Error('Invalid workflow node limit.');
  }
  return value;
}
