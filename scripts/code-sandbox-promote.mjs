import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { issueDockerImagePromotion, verifyDockerImagePromotion } from '../packages/adapter-code-docker/dist/index.js';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const dockerPath = process.env.MAYURA_DOCKER_CLI ?? (process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : '/usr/bin/docker');
const scoutPath = process.env.MAYURA_SCOUT_CLI ?? 'C:\\Program Files\\Docker\\Docker\\resources\\cli-plugins\\docker-scout.exe';
const dockerConfigInput = process.env.MAYURA_DOCKER_CONFIG;
const image = process.env.MAYURA_CODE_SANDBOX_IMAGE;
const provenance = process.env.MAYURA_CODE_SANDBOX_PROVENANCE;
const privateKeyPath = process.env.MAYURA_PROMOTION_PRIVATE_KEY;
const builderId = process.env.MAYURA_PROMOTION_BUILDER_ID ?? 'mayura-local-promotion';
const validitySeconds = Number(process.env.MAYURA_PROMOTION_VALIDITY_SECONDS ?? '3600');
assert(isAbsolute(dockerPath) && existsSync(dockerPath), 'MAYURA_DOCKER_CLI must name the absolute trusted Docker CLI.');
assert(isAbsolute(scoutPath) && existsSync(scoutPath), 'MAYURA_SCOUT_CLI must name the absolute trusted Docker Scout executable.');
assert(dockerConfigInput === undefined || (isAbsolute(dockerConfigInput) && existsSync(dockerConfigInput)),
  'MAYURA_DOCKER_CONFIG must name an existing absolute Docker configuration directory.');
if (dockerConfigInput !== undefined) assert((await stat(dockerConfigInput)).isDirectory(), 'MAYURA_DOCKER_CONFIG must name a directory.');
assert(typeof image === 'string' && /^sha256:[a-f0-9]{64}$/.test(image), 'MAYURA_CODE_SANDBOX_IMAGE must be an exact local image ID.');
assert(typeof provenance === 'string' && /^sha256:[a-f0-9]{64}$/.test(provenance), 'MAYURA_CODE_SANDBOX_PROVENANCE must be an exact SPDX digest.');
assert(typeof privateKeyPath === 'string' && isAbsolute(privateKeyPath), 'MAYURA_PROMOTION_PRIVATE_KEY must name an absolute protected Ed25519 PKCS#8 PEM file.');
assert(Number.isSafeInteger(validitySeconds) && validitySeconds >= 60 && validitySeconds <= 86_400, 'Promotion validity must be 60–86,400 seconds.');
assert(existsSync(join(workspace, 'packages', 'adapter-code-docker', 'dist', 'index.js')), 'Build the workspace before promoting the image.');

const artifacts = join(workspace, '.artifacts'); await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(join(artifacts, 'code-sandbox-promotion-'));
const sarifPath = join(output, 'scan.sarif.json');
const scoutEnv = Object.freeze(dockerConfigInput === undefined ? {} : { DOCKER_CONFIG: await realpath(dockerConfigInput) });
const inspected = await exec(dockerPath, ['image', 'inspect', '--format', '{{json .}}', image], {
  windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1_024, env: Object.freeze({}),
});
const metadata = JSON.parse(inspected.stdout);
assert(metadata.Id === image && metadata.Config?.Labels?.['dev.mayura.code-sandbox.provenance'] === provenance,
  'The exact local image and embedded provenance label must match before scanning.');

const versionResult = await exec(scoutPath, ['version'], {
  windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1_024, env: scoutEnv,
});
const scannerVersion = /version:\s*v?([0-9]+\.[0-9]+\.[0-9]+)/u.exec(`${versionResult.stdout}\n${versionResult.stderr}`)?.[1];
assert(scannerVersion, 'Docker Scout did not return a bounded semantic version.');
try {
  await exec(scoutPath, ['cves', '--format', 'sarif', '--output', sarifPath,
    '--only-severity', 'critical,high,unspecified', '--exit-code', `local://${image}`], {
    windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1_024 * 1_024, env: scoutEnv,
  });
} catch {
  throw new Error('Docker Scout rejected the exact image or could not complete its filtered scan. No promotion was issued.');
}
assert(existsSync(sarifPath), 'Docker Scout returned without the required SARIF report. No promotion was issued.');
const sarif = await readFile(sarifPath, { encoding: 'utf8' });
const privateKey = await readFile(await realpath(privateKeyPath), { encoding: 'utf8' });
const completedAt = new Date().toISOString(); const issuedAt = completedAt;
const expiresAt = new Date(Date.parse(issuedAt) + validitySeconds * 1_000).toISOString();
const promotion = issueDockerImagePromotion({ sarif, image, provenance, builderId, scannerId: 'docker-scout', scannerVersion,
  completedAt, issuedAt, expiresAt, privateKey });
verifyDockerImagePromotion(promotion, { image, provenance }, validitySeconds * 1_000);
await writeFile(join(output, 'promotion.json'), `${JSON.stringify(promotion, null, 2)}\n`, { flag: 'wx' });
const report = { status: 'passed', node: process.version, platform: process.platform, architecture: process.arch, output,
  image, provenance, scanner: { id: promotion.statement.scan.scannerId, version: promotion.statement.scan.scannerVersion,
    reportDigest: promotion.statement.scan.reportDigest, completedAt: promotion.statement.scan.completedAt },
  builderId: promotion.statement.builderId, issuedAt, expiresAt, promotion: join(output, 'promotion.json'), sarif: sarifPath };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(report));
