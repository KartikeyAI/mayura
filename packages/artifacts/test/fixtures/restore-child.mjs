import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createLocalArtifactStore } from '@mayura/artifacts';

const [rawDirectory, rawArchive] = process.argv.slice(2);
if (!rawDirectory || !rawArchive) throw new Error('Restore fixture requires a directory and archive.');
const directory = resolve(rawDirectory); const archivePath = resolve(rawArchive);
if (!basename(directory).startsWith('mayura-artifact-crash-') || !basename(dirname(archivePath)).startsWith('mayura-artifact-crash-')) {
  throw new Error('Restore fixture paths are outside the owned test boundary.');
}
const archive = new Uint8Array(await readFile(archivePath));
const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 1_048_576 });
if (!process.send) throw new Error('Restore fixture requires an IPC parent.');
process.send({ kind: 'started' });
const result = await store.restore(archive, { principalId: 'crash', projectId: 'restore' }, {
  maxArchiveBytes: 48 * 1_024 * 1_024, maxTotalBytes: 32 * 1_024 * 1_024, maxArtifacts: 32,
});
process.send({ kind: 'completed', result });
