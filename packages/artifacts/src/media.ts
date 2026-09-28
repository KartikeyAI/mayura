import { media, MayuraError, MEDIA_TYPES, type Media, type MediaType } from '@mayura/core';
import type { ArtifactReference, ArtifactScope } from './contracts.js';

/**
 * A stored image or PDF as media an agent can see: read for `scope` (the store checks the reference and the scope),
 * then checked like any media. Use it where media is needed but only a reference should be kept, for example in a
 * workflow step's `media`, or a server's `mediaArtifacts`.
 */
export async function mediaFromArtifact(store: { read(reference: ArtifactReference, scope: ArtifactScope): Promise<Uint8Array> },
  reference: ArtifactReference | Readonly<Record<string, unknown>>, scope: ArtifactScope): Promise<Media> {
  const mediaType = reference['mediaType'];
  if (typeof mediaType !== 'string' || !(MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new MayuraError('INVALID_INPUT', `Only ${MEDIA_TYPES.join(', ')} artifacts can be sent to a model.`);
  }
  const bytes = await store.read(reference as ArtifactReference, scope);
  const filename = reference['filename'];
  // The stored filename names the media when it is a plain name; otherwise the media is unnamed.
  const name = typeof filename === 'string' && /^[^\u0000-\u001f\u007f/\\]{1,255}$/u.test(filename) ? { name: filename } : {};
  return media(bytes, mediaType as MediaType, name);
}
