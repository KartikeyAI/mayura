// The optimistic document store on the in-memory backend: the conformance suites that need no second process (the D1
// and DynamoDB integration tests run every suite, crash tests included).
import { describe } from 'vitest';
import { memoryDocumentBackend } from '../src/document/memory-backend.js';
import { aggregateConformance } from '../../storage/test/conformance.js';
import { identityIntegrityConformance } from '../../storage/test/identity-integrity-conformance.js';
import { scheduledBounds } from '../../storage/test/scheduled-bounds-conformance.js';
import { workflowTreeCapabilityConformance } from '../../storage/test/workflow-tree-capability-conformance.js';
import { memoryConformance } from '../../memory/test/conformance.js';
import { nativeMemoryConformance } from '../../memory/test/native-conformance.js';
import { workflowConformance } from '../../workflows/test/conformance.js';
import { workflowTreeRuntimeConformance } from '../../workflows/test/tree-runtime-conformance.js';
import { workflowTreeCoordinatorConformance } from '../../workflows/test/tree-coordinator-conformance.js';
import { documentFixtures } from './document-fixtures.js';

const fixtures = documentFixtures(async () => {
  const backend = memoryDocumentBackend();
  return { backend, cleanup: async () => { backend.documents.clear(); },
    raw: {
      scan: async () => [...backend.documents.values()],
      write: async changes => {
        for (const change of changes) {
          const id = `${change.partition}\u0000${change.sort}`; const current = backend.documents.get(id);
          if (change.body === null) backend.documents.delete(id);
          else backend.documents.set(id, { partition: change.partition, sort: change.sort, version: (current?.version ?? 0) + 1, body: change.body });
        }
      },
    } };
});

describe('document store on memory', () => {
  aggregateConformance('Document memory', fixtures.simple);
  identityIntegrityConformance('Document memory', fixtures.simple);
  scheduledBounds('Document memory', fixtures.simple);
  memoryConformance('Document memory', fixtures.simple as never);
  nativeMemoryConformance('Document memory', fixtures.simple);
  workflowConformance('Document memory', fixtures.simple);
  workflowTreeCapabilityConformance('Document memory', fixtures.trees as never);
  workflowTreeRuntimeConformance('Document memory', fixtures.trees as never);
  workflowTreeCoordinatorConformance('Document memory', fixtures.trees as never);
});
