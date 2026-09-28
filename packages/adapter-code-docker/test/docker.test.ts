import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDockerQuickJsSandboxAdapter, createPromotedDockerQuickJsSandboxAdapter, serializeDockerImagePromotion,
  issueDockerImagePromotion, verifyDockerImagePromotion, type DockerImagePromotionStatement } from '../src/index.js';
import { dockerRunArguments } from '../src/options.js';
// Any absolute path on the current platform: these tests never execute Docker.
const dockerPath = (process.platform === 'win32' ? 'C:\\docker.exe' : '/usr/bin/docker');

const image = `sha256:${'a'.repeat(64)}`; const provenance = `sha256:${'b'.repeat(64)}`;
const code = (value: string) => expect.objectContaining({ code: value });
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
  it('is a production adapter pinned to an absolute CLI and an immutable image content ID', () => {
    expect(createDockerQuickJsSandboxAdapter({ dockerPath, image, provenance })).toEqual({ id: 'mayura.quickjs-docker', version: '1.0.0', qualification: 'production' });
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'docker', image, provenance })).toThrowError(code('INVALID_CONFIG'));
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image: 'node:latest', provenance })).toThrowError(code('INVALID_CONFIG'));
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image: `sha256:${'A'.repeat(64)}`, provenance })).toThrowError(code('INVALID_CONFIG'));
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image, provenance: 'sha256:bad' })).toThrowError(code('INVALID_CONFIG'));
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image, provenance, pull: true } as never))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG', message: 'Unknown Docker adapter option "pull".' }));
  });

  it('accepts a local daemon socket and an OCI runtime, and nothing that could smuggle flags', () => {
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image, provenance, host: 'unix:///run/user/1000/docker.sock', runtime: 'runsc' })).not.toThrow();
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image, provenance, host: 'npipe:////./pipe/docker_engine' })).not.toThrow();
    for (const host of ['tcp://10.0.0.1:2375', 'unix://relative.sock', 'unix:///run/docker.sock --privileged', 'ssh://host']) {
      expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image, provenance, host })).toThrowError(code('INVALID_CONFIG'));
    }
    for (const runtime of ['--privileged', 'runc --cap-add=ALL', '']) {
      expect(() => createDockerQuickJsSandboxAdapter({ dockerPath, image, provenance, runtime })).toThrowError(code('INVALID_CONFIG'));
    }
  });

  it('runs every container with the documented confinement flags', () => {
    const limits = { cpuMillis: 1, wallTimeMillis: 1, memoryBytes: 32 * 1_024 * 1_024, scratchBytes: 4_096, maxInputBytes: 1,
      maxOutputBytes: 1, maxToolInputBytes: 1, maxToolCalls: 1, maxToolConcurrency: 1 };
    const memory = `${32 * 1_024 * 1_024 + 268_435_456}b`;
    expect(dockerRunArguments({ dockerPath, image, provenance }, 'mayura-code-x', limits)).toEqual(['run', '--rm', '--interactive', '--pull=never',
      '--name', 'mayura-code-x', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
      '--security-opt=seccomp=builtin', '--pids-limit=16', '--ulimit=nofile=64:64', '--cpus=1', '--memory', memory, '--memory-swap', memory,
      '--user=65532:65532', '--ipc=none', '--log-driver=none', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=4096', image]);
    const custom = dockerRunArguments({ dockerPath, image, provenance, host: 'unix:///run/user/1000/docker.sock', runtime: 'runsc' }, 'mayura-code-y', limits);
    expect(custom.slice(0, 3)).toEqual(['--host', 'unix:///run/user/1000/docker.sock', 'run']);
    expect(custom.slice(-2)).toEqual(['--runtime=runsc', image]);
    expect(custom).not.toContain('--privileged');
  });

  it('verifies a fresh clean Ed25519 promotion for the exact subject', () => {
    const proof = signedPromotion();
    expect(verifyDockerImagePromotion(proof, { image, provenance }, 30_000)).toEqual(proof.statement);
    expect(createPromotedDockerQuickJsSandboxAdapter({ dockerPath, image, provenance, promotion: signedPromotion() }).qualification).toBe('production');
    expect(() => createPromotedDockerQuickJsSandboxAdapter({ dockerPath, image, provenance } as never)).toThrowError(code('INVALID_CONFIG'));
  });

  it('rejects tampering, findings, stale scans, wrong subjects and ambiguous data with precise codes', () => {
    const proof = signedPromotion();
    expect(() => verifyDockerImagePromotion({ ...proof, signature: `base64:${Buffer.alloc(64).toString('base64')}` }, { image, provenance }, 30_000))
      .toThrowError(code('INTEGRITY_VIOLATION'));
    expect(() => verifyDockerImagePromotion({ ...proof, statement: { ...proof.statement, builderId: 'someone-else' } }, { image, provenance }, 30_000))
      .toThrowError(code('INTEGRITY_VIOLATION'));
    expect(() => verifyDockerImagePromotion(proof, { image: `sha256:${'d'.repeat(64)}`, provenance }, 30_000)).toThrowError(code('INTEGRITY_VIOLATION'));
    const findings = signedPromotion({ scan: { ...proof.statement.scan, high: 1 } });
    expect(() => verifyDockerImagePromotion(findings, { image, provenance }, 30_000)).toThrowError(code('PERMISSION_DENIED'));
    expect(() => verifyDockerImagePromotion(proof, { image, provenance }, 1)).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED',
      message: expect.stringContaining('older than maxScanAgeMs') }));
    const now = Date.now();
    const expired = signedPromotion({ scan: { ...proof.statement.scan, completedAt: new Date(now - 3_000).toISOString() },
      issuedAt: new Date(now - 2_000).toISOString(), expiresAt: new Date(now - 1_000).toISOString() });
    expect(() => verifyDockerImagePromotion(expired, { image, provenance }, 30_000)).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED',
      message: expect.stringContaining('expired at') }));
    expect(() => verifyDockerImagePromotion(proof, { image, provenance }, 0)).toThrowError(code('INVALID_CONFIG'));
    const extended = { ...proof.statement, extra: true } as unknown as DockerImagePromotionStatement;
    expect(() => serializeDockerImagePromotion(extended)).toThrowError(code('INVALID_CONFIG'));
    const accessor = Object.defineProperty({}, 'statement', { enumerable: true, get: () => proof.statement });
    expect(() => verifyDockerImagePromotion(accessor as never, { image, provenance }, 30_000)).toThrowError(code('INVALID_CONFIG'));
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
      sarif: JSON.stringify({ version: '2.1.0', runs: [{ results: [{ ruleId: 'CVE-1' }] }] }) })).toThrowError(code('PERMISSION_DENIED'));
    expect(() => issueDockerImagePromotion({ ...issuance, sarif: 'not json' })).toThrowError(code('INVALID_CONFIG'));
    const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => issueDockerImagePromotion({ ...issuance, privateKey: rsa.export({ type: 'pkcs8', format: 'pem' }).toString() })).toThrowError(code('INVALID_CONFIG'));
  });
});
