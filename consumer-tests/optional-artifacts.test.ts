import {
  createLocalArtifactStore,
  type ArtifactAuditResult,
  type ArtifactDisclosure,
  type ArtifactReference,
  type ArtifactRestoreResult,
  type ArtifactScope,
  type LocalArtifactStore,
  type StagedArtifact,
} from '@mayura/artifacts';

declare const rootDirectory: string;
const scope: ArtifactScope = { principalId: 'tenant', projectId: 'project' };
const store: LocalArtifactStore = createLocalArtifactStore({ rootDirectory, maxArtifactBytes: 1_024 });
const staged: Promise<StagedArtifact> = store.stage({ scope, content: new Uint8Array(), mediaType: 'text/plain', classification: 'internal' });
const reference: Promise<ArtifactReference> = staged.then((value) => store.commit(value));
const disclosure: Promise<ArtifactDisclosure> = reference.then((value) => store.disclose(value, scope, { classifications: ['internal'], maxBytes: 1_024 }));
const audit: Promise<ArtifactAuditResult> = reference.then((value) => store.audit([value], scope, { maxTotalBytes: 1_024 }));
const archive: Promise<Uint8Array> = reference.then((value) => store.backup({ scope, references: [value], authoritativeSetComplete: true, maxTotalBytes: 1_024 }));
const restored: Promise<ArtifactRestoreResult> = archive.then((value) => createLocalArtifactStore({ rootDirectory: `${rootDirectory}-restore`, maxArtifactBytes: 1_024 })
  .restore(value, scope, { maxArchiveBytes: 4_096, maxTotalBytes: 1_024, maxArtifacts: 1 }));
const discarded: Promise<boolean> = store.stage({ scope, content: new Uint8Array(), mediaType: 'text/plain', classification: 'internal' })
  .then((value) => store.discard(value));
void disclosure;
void audit;
void restored;
void discarded;
// @ts-expect-error Content must be explicit bytes, not an implicitly encoded string.
void store.stage({ scope, content: 'secret', mediaType: 'text/plain', classification: 'internal' });
