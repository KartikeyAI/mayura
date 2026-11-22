import { DEFAULT_WORKFLOW_MAX_NODES } from '@mayura/core';

/**
 * A larger graph does not grant more concurrent storage requests. Retain the legacy
 * wave width for existing graphs; wider graphs use small batches to bound CAS
 * contention as well as queue occupancy. Settle each batch before advancing.
 */
export async function advanceWorkflowNodes<T extends { readonly kind: string }>(
  nodes: readonly T[],
  execute: (node: T) => Promise<void>,
): Promise<void> {
  const large = nodes.length > DEFAULT_WORKFLOW_MAX_NODES;
  for (let offset = 0; offset < nodes.length;) {
    // Join transitions contend on the same aggregate; concurrent CAS adds work without parallel effects.
    const width = large ? (nodes[offset]!.kind === 'join' ? 1 : 8) : DEFAULT_WORKFLOW_MAX_NODES;
    const results = await Promise.allSettled(nodes.slice(offset, offset + width).map(execute));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    offset += width;
  }
}
