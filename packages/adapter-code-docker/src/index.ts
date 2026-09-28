import { execFile, spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { promisify } from 'node:util';
import { createQuickJsProtocolAdapter, type QuickJsChildProcess, type QuickJsWorkerProcess } from '@mayura/adapter-code-quickjs';
import type { SandboxAdapter, SandboxExecutionRequest } from '@mayura/code-mode';
import { config, dockerRunArguments, fail, imageId, provenanceDigest } from './options.js';

const executeFile = promisify(execFile);
const provenanceLabel = 'dev.mayura.code-sandbox.provenance';

export interface DockerQuickJsAdapterOptions {
  /** Absolute trusted Docker CLI path. PATH lookup is deliberately unsupported. */
  readonly dockerPath: string;
  /** Exact locally present content ID returned by `docker image inspect --format {{.Id}}`. */
  readonly image: string;
  /** Exact SHA-256 digest of the retained SPDX document embedded and labeled by the build. */
  readonly provenance: string;
  /**
   * Docker daemon to use, as `unix:///absolute/path.sock` or `npipe:////./pipe/name`; for example a rootless daemon's
   * socket. Defaults to the CLI's default daemon. The CLI runs with an empty environment, so `DOCKER_HOST` is ignored.
   */
  readonly host?: string;
  /** OCI runtime for the sandbox container, such as `runsc` (gVisor). Defaults to the daemon's default runtime. */
  readonly runtime?: string;
}

export interface DockerImagePromotionStatement {
  readonly format: 'mayura-docker-promotion-v1';
  readonly subject: { readonly image: string; readonly provenance: string };
  readonly builderId: string;
  readonly scan: {
    readonly scannerId: string; readonly scannerVersion: string; readonly reportDigest: string;
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
export interface DockerImagePromotionIssuance {
  /** Exact UTF-8 SARIF emitted by the fixed high/critical/unspecified scan command. */
  readonly sarif: string;
  readonly image: string;
  readonly provenance: string;
  readonly builderId: string;
  readonly scannerId: string;
  readonly scannerVersion: string;
  readonly completedAt: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Ed25519 private key in PKCS#8 PEM. It is never returned. */
  readonly privateKey: string;
}

const identity = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const own = (value: unknown, expected: readonly string[]): Record<string, PropertyDescriptor> => {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_CONFIG', 'Docker promotion data must be plain objects.');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== expected.length || expected.some(key => !fields[key] || !('value' in fields[key]!))) {
    fail('INVALID_CONFIG', `Docker promotion data must have exactly these fields: ${expected.join(', ')}.`);
  }
  return fields;
};
const text = (value: unknown, pattern = identity): string => {
  if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_CONFIG', 'Docker promotion data contains an invalid identifier or digest.');
  return value;
};
const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('INVALID_CONFIG', 'Docker promotion finding counts must be non-negative integers.');
  return value;
};
const instant = (value: unknown): { readonly value: string; readonly time: number } => {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail('INVALID_CONFIG', 'Docker promotion timestamps must be ISO 8601 strings in the form Date.prototype.toISOString produces.');
  return { value: value as string, time };
};

function statement(value: unknown): DockerImagePromotionStatement {
  const root = own(value, ['format', 'subject', 'builderId', 'scan', 'issuedAt', 'expiresAt']);
  if (root['format']!.value !== 'mayura-docker-promotion-v1') fail('INVALID_CONFIG', 'The Docker promotion statement format must be "mayura-docker-promotion-v1".');
  const subject = own(root['subject']!.value, ['image', 'provenance']);
  const scan = own(root['scan']!.value, ['scannerId', 'scannerVersion', 'reportDigest', 'completedAt', 'critical', 'high', 'unknown']);
  const issued = instant(root['issuedAt']!.value); const expires = instant(root['expiresAt']!.value); const completed = instant(scan['completedAt']!.value);
  if (completed.time > issued.time || issued.time >= expires.time) fail('INVALID_CONFIG', 'Docker promotion timestamps must satisfy scan.completedAt <= issuedAt < expiresAt.');
  return Object.freeze({
    format: 'mayura-docker-promotion-v1',
    subject: Object.freeze({ image: text(subject['image']!.value, imageId), provenance: text(subject['provenance']!.value, provenanceDigest) }),
    builderId: text(root['builderId']!.value),
    scan: Object.freeze({ scannerId: text(scan['scannerId']!.value), scannerVersion: text(scan['scannerVersion']!.value),
      reportDigest: text(scan['reportDigest']!.value, provenanceDigest), completedAt: completed.value,
      critical: count(scan['critical']!.value), high: count(scan['high']!.value), unknown: count(scan['unknown']!.value) }),
    issuedAt: issued.value, expiresAt: expires.value,
  });
}

/** Stable bytes for CI signing; validation rejects extensions and ambiguous data before serialization. */
export function serializeDockerImagePromotion(value: DockerImagePromotionStatement): string {
  return JSON.stringify(statement(value));
}

/** Converts a successful empty bounded SARIF report into a signed promotion proof. */
export function issueDockerImagePromotion(value: DockerImagePromotionIssuance): DockerImagePromotionProof {
  const fields = own(value, ['sarif', 'image', 'provenance', 'builderId', 'scannerId', 'scannerVersion', 'completedAt', 'issuedAt', 'expiresAt', 'privateKey']);
  const sarif = fields['sarif']!.value; const privateKey = fields['privateKey']!.value;
  if (typeof sarif !== 'string' || Buffer.byteLength(sarif) < 2 || Buffer.byteLength(sarif) > 16 * 1_024 * 1_024
    || typeof privateKey !== 'string' || privateKey.length < 80 || privateKey.length > 16_384) {
    fail('INVALID_CONFIG', 'Promotion issuance needs sarif as 2 bytes to 16 MiB of text and privateKey as a PEM string.');
  }
  let report: unknown;
  try { report = JSON.parse(sarif as string); } catch { fail('INVALID_CONFIG', 'Promotion issuance needs sarif to be valid SARIF JSON.'); }
  const root = own(report, ['version', 'runs', '$schema'].filter(key => Object.hasOwn(report as object, key)));
  if (root['version']?.value !== '2.1.0' || !Array.isArray(root['runs']?.value) || root['runs']!.value.length < 1 || root['runs']!.value.length > 16) {
    fail('INVALID_CONFIG', 'Promotion issuance needs SARIF version 2.1.0 with 1 to 16 runs.');
  }
  for (const item of root['runs']!.value as unknown[]) {
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) fail('INVALID_CONFIG', 'Promotion issuance found a SARIF run that is not an object.');
    const results = Object.getOwnPropertyDescriptor(item, 'results');
    if (!results || !('value' in results) || !Array.isArray(results.value) || results.value.length !== 0) {
      fail('PERMISSION_DENIED', 'Promotion is denied: the scan reports findings, or a SARIF run has no results array.');
    }
  }
  const completed = instant(fields['completedAt']!.value); const issued = instant(fields['issuedAt']!.value); const expires = instant(fields['expiresAt']!.value);
  if (completed.time > issued.time || issued.time >= expires.time) fail('INVALID_CONFIG', 'Promotion timestamps must satisfy completedAt <= issuedAt < expiresAt.');
  let key!: ReturnType<typeof createPrivateKey>;
  try { key = createPrivateKey(privateKey as string); } catch { fail('INVALID_CONFIG', 'Promotion issuance needs privateKey to be a readable PEM private key.'); }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') fail('INVALID_CONFIG', 'Promotion issuance needs an Ed25519 private key.');
  const promoted: DockerImagePromotionStatement = {
    format: 'mayura-docker-promotion-v1', subject: { image: text(fields['image']!.value, imageId), provenance: text(fields['provenance']!.value, provenanceDigest) },
    builderId: text(fields['builderId']!.value), scan: { scannerId: text(fields['scannerId']!.value), scannerVersion: text(fields['scannerVersion']!.value),
      reportDigest: `sha256:${createHash('sha256').update(sarif, 'utf8').digest('hex')}`, completedAt: completed.value,
      critical: 0, high: 0, unknown: 0 }, issuedAt: issued.value, expiresAt: expires.value,
  };
  const serialized = serializeDockerImagePromotion(promoted);
  const proof = { statement: promoted, signature: `base64:${sign(null, Buffer.from(serialized), key).toString('base64')}`,
    publicKey: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() };
  return promotion(proof);
}

function promotion(value: unknown): DockerImagePromotionProof {
  const fields = own(value, ['statement', 'signature', 'publicKey']);
  const signed = statement(fields['statement']!.value);
  const signature = fields['signature']!.value; const publicKey = fields['publicKey']!.value;
  if (typeof signature !== 'string' || !/^base64:[A-Za-z0-9+/]+={0,2}$/.test(signature)
    || typeof publicKey !== 'string' || publicKey.length < 80 || publicKey.length > 4_096) {
    fail('INVALID_CONFIG', 'A Docker promotion needs signature as "base64:<signature>" and publicKey as a PEM string.');
  }
  const encoded = (signature as string).slice(7); const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== encoded) fail('INVALID_CONFIG', 'The Docker promotion signature must be a base64 Ed25519 signature (64 bytes).');
  let key!: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey(publicKey as string); } catch { fail('INVALID_CONFIG', 'The Docker promotion publicKey is not a readable PEM public key.'); }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') fail('INVALID_CONFIG', 'The Docker promotion publicKey must be an Ed25519 key.');
  if (!verify(null, Buffer.from(JSON.stringify(signed)), key, decoded)) {
    fail('INTEGRITY_VIOLATION', 'The Docker promotion signature does not verify with the pinned public key; the statement was altered or signed by another key.');
  }
  return Object.freeze({ statement: signed, signature: signature as string, publicKey: publicKey as string });
}

function verifyPromotion(proof: DockerImagePromotionProof, expected: Pick<DockerQuickJsAdapterOptions, 'image' | 'provenance'>,
  maxScanAgeMs: number, now: number): DockerImagePromotionStatement {
  if (!Number.isSafeInteger(maxScanAgeMs) || maxScanAgeMs < 1 || maxScanAgeMs > 7 * 86_400_000 || !Number.isSafeInteger(now) || now < 0) {
    fail('INVALID_CONFIG', 'maxScanAgeMs must be an integer from 1 to 604,800,000 (seven days).');
  }
  const verified = promotion(proof).statement; const scanned = Date.parse(verified.scan.completedAt);
  if (verified.subject.image !== expected.image || verified.subject.provenance !== expected.provenance) {
    fail('INTEGRITY_VIOLATION', 'The Docker promotion is for a different image or provenance digest than the adapter uses.');
  }
  if (verified.scan.critical !== 0 || verified.scan.high !== 0 || verified.scan.unknown !== 0) {
    fail('PERMISSION_DENIED', 'The Docker promotion reports critical, high or unknown findings; fix them and issue a new promotion.');
  }
  if (now < Date.parse(verified.issuedAt)) fail('PERMISSION_DENIED', `The Docker promotion is not valid until ${verified.issuedAt}; check the host clock.`);
  if (now >= Date.parse(verified.expiresAt)) fail('PERMISSION_DENIED', `The Docker promotion expired at ${verified.expiresAt}; rescan the image and issue a new promotion.`);
  if (now - scanned > maxScanAgeMs) fail('PERMISSION_DENIED', `The Docker promotion's scan (${verified.scan.completedAt}) is older than maxScanAgeMs; rescan the image and issue a new promotion.`);
  return verified;
}

/** Verifies a signed, clean, fresh statement against the exact configured image identity and current host time. */
export function verifyDockerImagePromotion(proof: DockerImagePromotionProof, expected: Pick<DockerQuickJsAdapterOptions, 'image' | 'provenance'>,
  maxScanAgeMs = 86_400_000): DockerImagePromotionStatement {
  return verifyPromotion(proof, expected, maxScanAgeMs, Date.now());
}

function createAdapter(selected: DockerQuickJsAdapterOptions, admit?: () => boolean): SandboxAdapter {
  const global = selected.host ? ['--host', selected.host] : [];
  return createQuickJsProtocolAdapter({
    id: 'mayura.quickjs-docker',
    version: '1.0.0',
    qualification: 'production',
    isAvailable: async () => {
      try {
        if (admit && !admit()) return false;
        const result = await executeFile(selected.dockerPath, [...global, 'image', 'inspect', '--format', '{{json .}}', selected.image], {
          windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1_024, env: Object.freeze({}),
        });
        const inspected = JSON.parse(result.stdout) as { Id?: unknown; Config?: { Labels?: Record<string, unknown> | null } };
        return inspected.Id === selected.image && inspected.Config?.Labels?.[provenanceLabel] === selected.provenance;
      } catch { return false; }
    },
    launch: (request: SandboxExecutionRequest): QuickJsWorkerProcess => {
      const name = `mayura-code-${randomUUID()}`;
      const child = spawn(selected.dockerPath, dockerRunArguments(selected, name, request.manifest.limits), {
        windowsHide: true,
        env: Object.freeze({}),
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as QuickJsChildProcess;
      const terminate = (): void => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill('SIGKILL');
        // Killing the CLI does not stop the container, so remove it by its unique name.
        const remover = execFile(selected.dockerPath, [...global, 'rm', '--force', name], { windowsHide: true, env: Object.freeze({}), timeout: 10_000 }, () => undefined);
        remover.unref();
      };
      return Object.freeze({ child, terminate });
    },
  });
}

/** Creates the Docker sandbox adapter: the QuickJS worker inside a locked-down container from an exact local image. */
export function createDockerQuickJsSandboxAdapter(options: DockerQuickJsAdapterOptions): SandboxAdapter {
  return createAdapter(config(options));
}

/** Requires a currently valid clean Ed25519-signed promotion in addition to exact local image inspection. */
export function createPromotedDockerQuickJsSandboxAdapter(options: PromotedDockerQuickJsAdapterOptions): SandboxAdapter {
  const selected = config(options, ['promotion', 'maxScanAgeMs']);
  if (!Object.hasOwn(options, 'promotion')) fail('INVALID_CONFIG', 'promotion is required; use createDockerQuickJsSandboxAdapter for an unpromoted image.');
  const proof = promotion(options.promotion);
  const maximum = options.maxScanAgeMs ?? 86_400_000;
  verifyDockerImagePromotion(proof, selected, maximum);
  return createAdapter(selected, () => {
    try { verifyDockerImagePromotion(proof, selected, maximum); return true; }
    catch { return false; }
  });
}
