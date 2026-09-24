import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDockerQuickJsSandboxAdapter, createPromotedDockerQuickJsSandboxAdapter, serializeDockerImagePromotion,
  verifyDockerImagePromotion, type DockerImagePromotionStatement } from '../src/index.js';

const image = `sha256:${'a'.repeat(64)}`; const provenance = `sha256:${'b'.repeat(64)}`;
function signedPromotion(overrides: Partial<DockerImagePromotionStatement> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = Date.now();
  const statement: DockerImagePromotionStatement = {
    format: 'mayura-docker-promotion-v1', subject: { image, provenance }, builderId: 'mayura-ci',
    scan: { scannerId: 'scanner', scannerVersion: '1.2.3', databaseDigest: `sha256:${'c'.repeat(64)}`,
      completedAt: new Date(now - 2_000).toISOString(), critical: 0, high: 0, unknown: 0 },
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), ...overrides,
  };
  const signature = sign(null, Buffer.from(serializeDockerImagePromotion(statement)), privateKey).toString('base64');
  return { statement, signature: `base64:${signature}`, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

describe('Docker QuickJS adapter configuration', () => {
  it('requires an absolute CLI and immutable image content ID', () => {
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'docker', image, provenance })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image: 'node:latest', provenance })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image: `sha256:${'A'.repeat(64)}`, provenance })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image: `sha256:${'a'.repeat(64)}`, provenance: 'sha256:bad' })).toThrow(TypeError);
  });

  it('verifies a fresh clean Ed25519 promotion for the exact subject', () => {
    const proof = signedPromotion();
    expect(verifyDockerImagePromotion(proof, { image, provenance }, 30_000)).toEqual(proof.statement);
    expect(() => createPromotedDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image, provenance,
      promotion: signedPromotion({ issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scan: { ...proof.statement.scan, completedAt: new Date(Date.now() - 2_000).toISOString() } }) })).not.toThrow();
  });

  it('rejects tampering, findings, stale scans, wrong subjects and ambiguous data', () => {
    const proof = signedPromotion();
    expect(() => verifyDockerImagePromotion({ ...proof, signature: `base64:${Buffer.alloc(64).toString('base64')}` }, { image, provenance }, 30_000)).toThrow(TypeError);
    expect(() => verifyDockerImagePromotion(proof, { image: `sha256:${'d'.repeat(64)}`, provenance }, 30_000)).toThrow(TypeError);
    const findings = signedPromotion({ scan: { ...proof.statement.scan, high: 1 } });
    expect(() => verifyDockerImagePromotion(findings, { image, provenance }, 30_000)).toThrow(TypeError);
    expect(() => verifyDockerImagePromotion(proof, { image, provenance }, 1)).toThrow(TypeError);
    const extended = { ...proof.statement, extra: true } as unknown as DockerImagePromotionStatement;
    expect(() => serializeDockerImagePromotion(extended)).toThrow(TypeError);
    const accessor = Object.defineProperty({}, 'statement', { enumerable: true, get: () => proof.statement });
    expect(() => verifyDockerImagePromotion(accessor as never, { image, provenance }, 30_000)).toThrow(TypeError);
  });
});
