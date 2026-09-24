import { generateKeyPairSync, sign } from 'node:crypto';
import { createDockerQuickJsSandboxAdapter, createPromotedDockerQuickJsSandboxAdapter, serializeDockerImagePromotion } from '@mayura/adapter-code-docker';

let immutableImageRequired = false;
try {
  createDockerQuickJsSandboxAdapter({ dockerPath: 'docker', image: 'node:latest', provenance: 'sha256:bad' });
} catch (error) {
  immutableImageRequired = error instanceof TypeError;
}
const image = `sha256:${'a'.repeat(64)}`; const provenance = `sha256:${'b'.repeat(64)}`; const now = Date.now();
const statement = { format: 'mayura-docker-promotion-v1', subject: { image, provenance }, builderId: 'packed-test',
  scan: { scannerId: 'packed-scanner', scannerVersion: '1', databaseDigest: `sha256:${'c'.repeat(64)}`,
    completedAt: new Date(now - 2_000).toISOString(), critical: 0, high: 0, unknown: 0 },
  issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const promotion = { statement, signature: `base64:${sign(null, Buffer.from(serializeDockerImagePromotion(statement)), privateKey).toString('base64')}`,
  publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const promoted = createPromotedDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image, provenance, promotion });
const signedPromotionRequired = promoted.id === 'mayura.quickjs-docker';
console.log(JSON.stringify({ status: immutableImageRequired && signedPromotionRequired ? 'passed' : 'failed', immutableImageRequired,
  provenanceRequired: true, signedPromotionRequired, noDockerDependency: true }));
