import {
  createLocalArtifactStore,
  type ArtifactDisclosure,
  type ArtifactReference,
  type ArtifactScope,
  type LocalArtifactStore,
  type StagedArtifact,
} from '@mayura/artifacts';

declare const rootDirectory: string;
const scope: ArtifactScope = { tenantId: 'tenant', projectId: 'project' };
const store: LocalArtifactStore = createLocalArtifactStore({ rootDirectory, maxArtifactBytes: 1_024 });
const staged: Promise<StagedArtifact> = store.stage({ scope, content: new Uint8Array(), mediaType: 'text/plain', classification: 'internal' });
const reference: Promise<ArtifactReference> = staged.then((value) => store.commit(value));
const disclosure: Promise<ArtifactDisclosure> = reference.then((value) => store.disclose(value, scope, { classifications: ['internal'], maxBytes: 1_024 }));
void disclosure;
// @ts-expect-error Content must be explicit bytes, not an implicitly encoded string.
void store.stage({ scope, content: 'secret', mediaType: 'text/plain', classification: 'internal' });
