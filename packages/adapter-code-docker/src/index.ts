import { execFile, spawn } from 'node:child_process';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { createQuickJsProtocolAdapter, type QuickJsChildProcess, type QuickJsWorkerProcess } from '@mayura/adapter-code-quickjs';
import type { SandboxAdapter, SandboxExecutionRequest } from '@mayura/code-mode';

const executeFile = promisify(execFile);
const imageId = /^sha256:[a-f0-9]{64}$/;
const provenanceDigest = /^sha256:[a-f0-9]{64}$/;
const provenanceLabel = 'dev.mayura.code-sandbox.provenance';

export interface DockerQuickJsAdapterOptions {
  /** Absolute trusted Docker CLI path. PATH lookup is deliberately unsupported. */
  readonly dockerPath: string;
  /** Exact locally present content ID returned by `docker image inspect --format {{.Id}}`. */
  readonly image: string;
  /** Exact SHA-256 digest of the retained SPDX document embedded and labeled by the build. */
  readonly provenance: string;
}

export interface DockerImagePromotionStatement {
  readonly format: 'mayura-docker-promotion-v1';
  readonly subject: { readonly image: string; readonly provenance: string };
  readonly builderId: string;
  readonly scan: {
    readonly scannerId: string; readonly scannerVersion: string; readonly databaseDigest: string;
    readonly completedAt: string; readonly critical: number; readonly high: number; readonly unknown: number;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export interface DockerImagePromotionProof {
  readonly statement: DockerImagePromotionStatement;
  /** `base64:` followed by the detached Ed25519 signature of the canonical statement. */
  readonly signature: string;
  /** Trusted Ed25519 SubjectPublicKeyInfo PEM pinned by the application. */
  readonly publicKey: string;
}
export interface PromotedDockerQuickJsAdapterOptions extends DockerQuickJsAdapterOptions {
  readonly promotion: DockerImagePromotionProof;
  /** Defaults to 24 hours; maximum seven days. */
  readonly maxScanAgeMs?: number;
}

const identity = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const own = (value: unknown, expected: readonly string[]): Record<string, PropertyDescriptor> => {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Promotion evidence must be plain data.');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== expected.length || expected.some(key => !fields[key] || !('value' in fields[key]!))) throw new TypeError('Promotion evidence has an invalid shape.');
  return fields;
};
const text = (value: unknown, pattern = identity): string => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError('Promotion evidence contains an invalid identity.');
  return value;
};
const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('Promotion evidence contains an invalid finding count.');
  return value;
};
const instant = (value: unknown): { readonly value: string; readonly time: number } => {
  if (typeof value !== 'string') throw new TypeError('Promotion evidence requires canonical timestamps.');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new TypeError('Promotion evidence requires canonical timestamps.');
  return { value, time };
};

function statement(value: unknown): DockerImagePromotionStatement {
  const root = own(value, ['format', 'subject', 'builderId', 'scan', 'issuedAt', 'expiresAt']);
  if (root['format']!.value !== 'mayura-docker-promotion-v1') throw new TypeError('Unsupported Docker promotion statement.');
  const subject = own(root['subject']!.value, ['image', 'provenance']);
  const scan = own(root['scan']!.value, ['scannerId', 'scannerVersion', 'databaseDigest', 'completedAt', 'critical', 'high', 'unknown']);
  const issued = instant(root['issuedAt']!.value); const expires = instant(root['expiresAt']!.value); const completed = instant(scan['completedAt']!.value);
  if (completed.time > issued.time || issued.time >= expires.time) throw new TypeError('Docker promotion timestamps are inconsistent.');
  return Object.freeze({
    format: 'mayura-docker-promotion-v1',
    subject: Object.freeze({ image: text(subject['image']!.value, imageId), provenance: text(subject['provenance']!.value, provenanceDigest) }),
    builderId: text(root['builderId']!.value),
    scan: Object.freeze({ scannerId: text(scan['scannerId']!.value), scannerVersion: text(scan['scannerVersion']!.value),
      databaseDigest: text(scan['databaseDigest']!.value, provenanceDigest), completedAt: completed.value,
      critical: count(scan['critical']!.value), high: count(scan['high']!.value), unknown: count(scan['unknown']!.value) }),
    issuedAt: issued.value, expiresAt: expires.value,
  });
}

/** Stable bytes for CI signing; validation rejects extensions and ambiguous data before serialization. */
export function serializeDockerImagePromotion(value: DockerImagePromotionStatement): string {
  return JSON.stringify(statement(value));
}

function promotion(value: unknown): DockerImagePromotionProof {
  const fields = own(value, ['statement', 'signature', 'publicKey']);
  const signed = statement(fields['statement']!.value);
  const signature = fields['signature']!.value; const publicKey = fields['publicKey']!.value;
  if (typeof signature !== 'string' || !/^base64:[A-Za-z0-9+/]+={0,2}$/.test(signature)
    || typeof publicKey !== 'string' || publicKey.length < 80 || publicKey.length > 4_096) throw new TypeError('Docker promotion proof is malformed.');
  const encoded = signature.slice(7); const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== encoded) throw new TypeError('Docker promotion signature is malformed.');
  const key = createPublicKey(publicKey);
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519'
    || !verify(null, Buffer.from(JSON.stringify(signed)), key, decoded)) throw new TypeError('Docker promotion signature is invalid.');
  return Object.freeze({ statement: signed, signature, publicKey });
}

function verifyPromotion(proof: DockerImagePromotionProof, expected: Pick<DockerQuickJsAdapterOptions, 'image' | 'provenance'>,
  maxScanAgeMs: number, now: number): DockerImagePromotionStatement {
  if (!Number.isSafeInteger(maxScanAgeMs) || maxScanAgeMs < 1 || maxScanAgeMs > 7 * 86_400_000 || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('Docker promotion freshness bounds are invalid.');
  }
  const verified = promotion(proof).statement; const scanned = Date.parse(verified.scan.completedAt);
  if (verified.subject.image !== expected.image || verified.subject.provenance !== expected.provenance
    || verified.scan.critical !== 0 || verified.scan.high !== 0 || verified.scan.unknown !== 0
    || now < Date.parse(verified.issuedAt) || now >= Date.parse(verified.expiresAt) || now - scanned > maxScanAgeMs) {
    throw new TypeError('Docker image promotion policy was not satisfied.');
  }
  return verified;
}

/** Verifies a signed, clean, fresh statement against the exact configured image identity and current host time. */
export function verifyDockerImagePromotion(proof: DockerImagePromotionProof, expected: Pick<DockerQuickJsAdapterOptions, 'image' | 'provenance'>,
  maxScanAgeMs = 86_400_000): DockerImagePromotionStatement {
  return verifyPromotion(proof, expected, maxScanAgeMs, Date.now());
}

function config(value: DockerQuickJsAdapterOptions): DockerQuickJsAdapterOptions {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Docker adapter configuration must be plain data.');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 3 || !fields['dockerPath'] || !('value' in fields['dockerPath'])
    || !fields['image'] || !('value' in fields['image']) || typeof fields['dockerPath'].value !== 'string'
    || !fields['provenance'] || !('value' in fields['provenance'])
    || !isAbsolute(fields['dockerPath'].value) || typeof fields['image'].value !== 'string' || !imageId.test(fields['image'].value)
    || typeof fields['provenance'].value !== 'string' || !provenanceDigest.test(fields['provenance'].value)) {
    throw new TypeError('Docker adapter requires an absolute CLI path plus exact image and provenance digests.');
  }
  return Object.freeze({ dockerPath: fields['dockerPath'].value, image: fields['image'].value, provenance: fields['provenance'].value });
}

function bytes(value: number): string { return `${value}b`; }

function createAdapter(selected: DockerQuickJsAdapterOptions, admit?: () => boolean): SandboxAdapter {
  return createQuickJsProtocolAdapter({
    id: 'mayura.quickjs-docker',
    version: '0.1.0',
    isAvailable: async () => {
      try {
        if (admit && !admit()) return false;
        const result = await executeFile(selected.dockerPath, ['image', 'inspect', '--format', '{{json .}}', selected.image], {
          windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1_024, env: Object.freeze({}),
        });
        const inspected = JSON.parse(result.stdout) as { Id?: unknown; Config?: { Labels?: Record<string, unknown> | null } };
        return inspected.Id === selected.image && inspected.Config?.Labels?.[provenanceLabel] === selected.provenance;
      } catch { return false; }
    },
    launch: (request: SandboxExecutionRequest): QuickJsWorkerProcess => {
      const name = `mayura-code-${randomUUID()}`;
      const memory = Math.min(2_415_919_104, request.manifest.limits.memoryBytes + 268_435_456);
      const args = ['run', '--rm', '--interactive', '--pull=never', '--name', name,
        '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--security-opt=seccomp=builtin',
        '--pids-limit=16', '--ulimit=nofile=64:64', '--cpus=1', '--memory', bytes(memory), '--memory-swap', bytes(memory),
        '--user=65532:65532', '--ipc=none', '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${request.manifest.limits.scratchBytes}`,
        selected.image];
      const child = spawn(selected.dockerPath, args, {
        windowsHide: true,
        env: Object.freeze({}),
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as QuickJsChildProcess;
      const terminate = (): void => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill('SIGKILL');
        const remover = execFile(selected.dockerPath, ['rm', '--force', name], { windowsHide: true, env: Object.freeze({}), timeout: 10_000 }, () => undefined);
        remover.unref();
      };
      return Object.freeze({ child, terminate });
    },
  });
}

/** Creates the hardened local Docker profile; qualification remains test-only until the full V15 matrix passes. */
export function createDockerQuickJsSandboxAdapter(options: DockerQuickJsAdapterOptions): SandboxAdapter {
  return createAdapter(config(options));
}

/** Requires a currently valid clean Ed25519-signed promotion in addition to exact local image inspection. */
export function createPromotedDockerQuickJsSandboxAdapter(options: PromotedDockerQuickJsAdapterOptions): SandboxAdapter {
  const fields = own(options, Object.hasOwn(options, 'maxScanAgeMs')
    ? ['dockerPath', 'image', 'provenance', 'promotion', 'maxScanAgeMs'] : ['dockerPath', 'image', 'provenance', 'promotion']);
  const selected = config({ dockerPath: fields['dockerPath']!.value, image: fields['image']!.value, provenance: fields['provenance']!.value });
  const proof = promotion(fields['promotion']!.value);
  const maximum = fields['maxScanAgeMs']?.value ?? 86_400_000;
  verifyDockerImagePromotion(proof, selected, maximum);
  return createAdapter(selected, () => {
    try { verifyDockerImagePromotion(proof, selected, maximum); return true; }
    catch { return false; }
  });
}
