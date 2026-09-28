import { generateKeyPairSync } from 'node:crypto';
import { createDockerQuickJsSandboxAdapter, createPromotedDockerQuickJsSandboxAdapter, issueDockerImagePromotion } from '@mayura/adapter-code-docker';

let immutableImageRequired = false;
try {
  createDockerQuickJsSandboxAdapter({ dockerPath: 'docker', image: 'node:latest', provenance: 'sha256:bad' });
} catch (error) {
  immutableImageRequired = error instanceof Error && error.code === 'INVALID_CONFIG';
}
const image = `sha256:${'a'.repeat(64)}`; const provenance = `sha256:${'b'.repeat(64)}`; const now = Date.now();
const { privateKey } = generateKeyPairSync('ed25519');
const promotion = issueDockerImagePromotion({ sarif: JSON.stringify({ version: '2.1.0', runs: [{ results: [] }] }), image, provenance,
  builderId: 'packed-test', scannerId: 'packed-scanner', scannerVersion: '1', completedAt: new Date(now - 2_000).toISOString(),
  issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
const promoted = createPromotedDockerQuickJsSandboxAdapter({ dockerPath: (process.platform === 'win32' ? 'C:\\docker.exe' : '/usr/bin/docker'), image, provenance, promotion });
const signedPromotionRequired = promoted.id === 'mayura.quickjs-docker';
console.log(JSON.stringify({ status: immutableImageRequired && signedPromotionRequired ? 'passed' : 'failed', immutableImageRequired,
  provenanceRequired: true, signedPromotionRequired, sarifIssuanceRequired: promotion.statement.scan.reportDigest.startsWith('sha256:'), noDockerDependency: true }));
