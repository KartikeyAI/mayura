// The file store contract against Azurite, Microsoft's Azure Storage emulator, which checks Shared Key signatures.
// Set MAYURA_TEST_AZURITE_URL to its blob endpoint with the account in the path:
//   docker run -d -p 127.0.0.1:10000:10000 mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0
//   MAYURA_TEST_AZURITE_URL=http://127.0.0.1:10000/devstoreaccount1
// Each run creates its own container, with Azurite's published development account key.
import { describe, expect, it } from 'vitest';
import { createFileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { azureBlobFiles, azureBlobVersion } from '../src/index.js';

const configured = process.env['MAYURA_TEST_AZURITE_URL'];
/** Azurite's well-known development account, the same in every installation. */
const account = 'devstoreaccount1';
const accountKey = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

/** Creates a container with its own Shared Key signing, so a wrong signature in the package cannot pass unnoticed. */
async function createContainer(endpoint: string, container: string): Promise<void> {
  const url = new URL(`${endpoint}/${container}?restype=container`);
  const date = new Date().toUTCString();
  const stringToSign = ['PUT', '', '', '', '', '', '', '', '', '', '', '', `x-ms-date:${date}\nx-ms-version:${azureBlobVersion}\n/${account}${url.pathname}\nrestype:container`].join('\n');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(accountKey), character => character.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign)))));
  const response = await fetch(url, { method: 'PUT', headers: { 'x-ms-date': date, 'x-ms-version': azureBlobVersion, authorization: `SharedKey ${account}:${signature}` } });
  if (!response.ok) throw new Error(`Creating the test container failed with HTTP ${response.status}.`);
}

describe.skipIf(!configured)('@mayurajs/filestorage-azure-blob against Azurite', async () => {
  const endpoint = configured ?? 'http://127.0.0.1:9/devstoreaccount1';
  const container = `mayura-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (configured) await createContainer(endpoint, container);
  const store = createFileStore(azureBlobFiles({ account, container, accountKey, endpoint }), { maxFileBytes: 4 * 1_048_576 });
  for (const test of fileStoreConformance) it(test.name, async () => { expect(await test.run({ store })).toBe('passed'); });

  it('refuses requests signed with another key', async () => {
    const wrong = createFileStore(azureBlobFiles({ account, container, accountKey: btoa('not-the-account-key-at-all-32by!'), endpoint }), { maxFileBytes: 1_024 });
    await expect(wrong.put('x.txt', new Uint8Array(1))).rejects.toMatchObject({ reason: 'authentication' });
  });
});
