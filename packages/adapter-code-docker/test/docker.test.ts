import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDockerQuickJsSandboxAdapter, createPromotedDockerQuickJsSandboxAdapter, serializeDockerImagePromotion,
  issueDockerImagePromotion, verifyDockerImagePromotion, type DockerImagePromotionStatement } from '../src/index.js';
// Any absolute path on the current platform: these tests never execute Docker.
const dockerPath = (process.platform === 'win32' ? 'C:\\docker.exe' : '/usr/bin/docker');

const image = `sha256:${'a'.repeat(64)}`; const provenance = `sha256:${'b'.repeat(64)}`;
function signedPromotion(overrides: Partial<DockerImagePromotionStatement> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = Date.now();
  const statement: DockerImagePromotionStatement = {
    format: 'mayura-docker-promotion-v1', subject: { image, provenance }, builderId: 'mayura-ci',
    scan: { scannerId: 'scanner', scannerVersion: '1.2.3', reportDigest: `sha256:${'c'.repeat(64)}`,
      completedAt: new Date(now - 2_000).toISOString(), critical: 0, high: 0, unknown: 0 },
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), ...overrides,
  };
  const signature = sign(null, Buffer.from(serializeDockerImagePromotion(statement)), privateKey).toString('base64');
  return { statement, signature: `base64:${signature}`, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

describe('Docker QuickJS adapter configuration', () => {
  it('requires an absolute CLI and immutable image content ID', () => {
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'docker', image, provenance })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image: 'node:latest', provenance })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image: `sha256:${'A'.repeat(64)}`, provenance })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image: `sha256:${'a'.repeat(64)}`, provenance: 'sha256:bad' })).toThrow(TypeError);
  });

  it('verifies a fresh clean Ed25519 promotion for the exact subject', () => {
    const proof = signedPromotion();
    expect(verifyDockerImagePromotion(proof, { image, provenance }, 30_000)).toEqual(proof.statement);
    expect(() => createPromotedDockerQuickJsSandboxAdapter({ dockerPath, image, provenance,
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

  it('issues promotion only from an empty bounded SARIF report and an Ed25519 key', () => {
    const { privateKey } = generateKeyPairSync('ed25519'); const now = Date.now();
    const issuance = { sarif: JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Docker Scout' } }, results: [] }] }),
      image, provenance, builderId: 'mayura-ci', scannerId: 'docker-scout', scannerVersion: '1.20.4',
      completedAt: new Date(now - 2_000).toISOString(), issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    const proof = issueDockerImagePromotion(issuance);
    expect(verifyDockerImagePromotion(proof, { image, provenance }, 30_000)).toEqual(proof.statement);
    expect(proof.statement.scan.reportDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() => issueDockerImagePromotion({ ...issuance,
      sarif: JSON.stringify({ version: '2.1.0', runs: [{ results: [{ ruleId: 'CVE-1' }] }] }) })).toThrow(TypeError);
    const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => issueDockerImagePromotion({ ...issuance, privateKey: rsa.export({ type: 'pkcs8', format: 'pem' }).toString() })).toThrow(TypeError);
  });
});
