import { MayuraError } from '@mayura/core';
import { StorageError, type AggregateStore } from './contracts.js';
import { workflowHashMaterial } from './workflow-format2.js';

/** Structurally matches `AgentServerOptions.submissionJournal`; the server package does not depend on storage. */
export interface SubmissionJournal {
  claim(input: { readonly owner: string; readonly key: string; readonly digest: string; readonly signal?: AbortSignal }):
    Promise<{ readonly status: 'claimed' } | { readonly status: 'existing'; readonly digest: string }>;
}

const encoder = new TextEncoder();
async function sha256(domain: string, value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(workflowHashMaterial(domain, value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Durable claim of every HTTP submission key before a run starts. A retry that reaches a new process after a
 * restart finds the claim and cannot start a duplicate run. Claims are permanent: they record only digests.
 */
export function createAggregateSubmissionJournal(store: AggregateStore): SubmissionJournal {
  if (!store || typeof store.create !== 'function') throw new MayuraError('INVALID_CONFIG', 'A submission journal requires an aggregate store.');
  return Object.freeze<SubmissionJournal>({
    async claim(input) {
      if (typeof input?.owner !== 'string' || input.owner.length < 1 || input.owner.length > 4_096 || typeof input.key !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.key) || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest)) {
        throw new MayuraError('INVALID_INPUT', 'A submission claim requires an owner, a bounded key and a request digest.');
      }
      input.signal?.throwIfAborted();
      const scope = await sha256('mayura:submission-journal-scope:v1', { owner: input.owner });
      const id = await sha256('mayura:submission-journal-entry:v1', { owner: input.owner, key: input.key });
      const existing = async (): Promise<{ readonly status: 'existing'; readonly digest: string }> => {
        const record = await store.read(scope, id); const digest = record?.state['digest'];
        if (!record || record.state['format'] !== 1 || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
          throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored submission claim failed integrity validation.');
        }
        return { status: 'existing' as const, digest };
      };
      if (await store.read(scope, id)) return existing();
      // Create-if-absent is the atomic primitive: exactly one claimant creates the record. A concurrent claimant with the
      // same digest sees created:false; one with a different digest is rejected as a conflict. Both then read the winner.
      try {
        const created = await store.create({ scope, id, idempotencyKey: id, definitionHash: await sha256('mayura:submission-journal-format:v1', {}),
          state: { format: 1, digest: input.digest }, events: [{ type: 'submission.claimed', data: {} }] });
        if (created.created) return { status: 'claimed' as const };
      } catch (error) { if (!(error instanceof StorageError) || error.storageCode !== 'CONFLICT') throw error; }
      return existing();
    },
  });
}
