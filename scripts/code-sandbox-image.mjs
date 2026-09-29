import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const dockerPath = process.env.MAYURA_DOCKER_CLI ?? (process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : '/usr/bin/docker');
assert(isAbsolute(dockerPath) && existsSync(dockerPath), 'MAYURA_DOCKER_CLI must name the absolute trusted Docker CLI.');
assert(existsSync(join(workspace, 'packages', 'adapter-code-quickjs', 'dist', 'worker.js')), 'Build the workspace before building the image.');

const artifacts = join(workspace, '.artifacts'); await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(join(artifacts, 'code-sandbox-image-'));
const root = join(output, 'root'); await mkdir(join(root, 'node_modules', '@jitl'), { recursive: true });
const variant = await realpath(join(workspace, 'packages', 'adapter-code-quickjs', 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync'));
const packages = new Map([
  [await realpath(join(dirname(variant), 'quickjs-ffi-types')), join(root, 'node_modules', '@jitl', 'quickjs-ffi-types')],
  [variant, join(root, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync')],
  [await realpath(join(workspace, 'packages', 'adapter-code-quickjs', 'node_modules', 'quickjs-emscripten-core')), join(root, 'node_modules', 'quickjs-emscripten-core')],
]);
for (const [source, destination] of packages) {
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path === source || !path.slice(source.length).replaceAll('\\', '/').includes('/node_modules/'),
  });
}
await copyFile(join(workspace, 'packages', 'adapter-code-quickjs', 'dist', 'worker.js'), join(root, 'worker.mjs'));
await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
const inventory = [];
async function walk(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path); const name = relative(root, path).replaceAll('\\', '/');
      inventory.push({ name, sha1: createHash('sha1').update(bytes).digest('hex'), sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error('Sandbox image context contains an unsupported filesystem entry.');
  }
}
await walk(root);
const inventoryDigest = createHash('sha256').update(JSON.stringify(inventory), 'utf8').digest('hex');
const packageVerificationCode = createHash('sha1').update(inventory.map(file => file.sha1).sort().join(''), 'utf8').digest('hex');
const sourceEpoch = process.env.SOURCE_DATE_EPOCH ?? '0';
const created = new Date(Number(sourceEpoch) * 1_000).toISOString();
assert(!Number.isNaN(Date.parse(created)), 'SOURCE_DATE_EPOCH must identify a valid timestamp.');
const spdx = {
  spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: 'mayura-code-sandbox',
  documentNamespace: `https://mayura.dev/spdx/code-sandbox/${inventoryDigest}`,
  creationInfo: { created, creators: ['Tool: mayura-code-sandbox-image/1.0.0'] },
  documentDescribes: ['SPDXRef-Package-Mayura-Code-Sandbox'],
  packages: [{ SPDXID: 'SPDXRef-Package-Mayura-Code-Sandbox', name: 'mayura-code-sandbox', versionInfo: '1.0.0',
    downloadLocation: 'NOASSERTION', filesAnalyzed: true, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION',
    copyrightText: 'NOASSERTION', packageVerificationCode: { packageVerificationCodeValue: packageVerificationCode } }],
  files: inventory.map((file, index) => ({ SPDXID: `SPDXRef-File-${index + 1}`, fileName: `./${file.name}`,
    checksums: [{ algorithm: 'SHA1', checksumValue: file.sha1 }, { algorithm: 'SHA256', checksumValue: file.sha256 }],
    licenseConcluded: 'NOASSERTION', licenseInfoInFiles: ['NOASSERTION'], copyrightText: 'NOASSERTION' })),
  relationships: inventory.map((_file, index) => ({ spdxElementId: 'SPDXRef-Package-Mayura-Code-Sandbox',
    relationshipType: 'CONTAINS', relatedSpdxElement: `SPDXRef-File-${index + 1}` })),
};
const spdxBytes = Buffer.from(`${JSON.stringify(spdx, null, 2)}\n`);
const provenance = `sha256:${createHash('sha256').update(spdxBytes).digest('hex')}`;
await writeFile(join(root, 'sbom.spdx.json'), spdxBytes);
await copyFile(join(workspace, 'packages', 'adapter-code-docker', 'image', 'Dockerfile'), join(output, 'Dockerfile'));
const tag = `mayura-code-sandbox:dev-${output.slice(-6).toLowerCase()}`;
await exec(dockerPath, ['build', '--pull=false', '--network=none', '--build-arg', `MAYURA_PROVENANCE=${provenance}`, '--tag', tag, output], {
  cwd: workspace, windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1_024 * 1_024,
});
const inspected = await exec(dockerPath, ['image', 'inspect', '--format', '{{json .}}', tag], { windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1_024 });
const imageMetadata = JSON.parse(inspected.stdout);
const image = imageMetadata.Id;
assert(typeof image === 'string' && /^sha256:[a-f0-9]{64}$/.test(image), 'Docker returned an invalid image ID.');
assert(imageMetadata.Config?.Labels?.['dev.mayura.code-sandbox.provenance'] === provenance,
  'Built image does not contain the exact generated provenance label.');
const report = { status: 'passed', node: process.version, platform: process.platform, architecture: process.arch, output, dockerPath, tag, image,
  provenance, sbom: join(root, 'sbom.spdx.json'), inventoryDigest, inventoryFiles: inventory.length,
  base: 'node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5',
  packages: ['quickjs-emscripten-core@0.32.0', '@jitl/quickjs-wasmfile-release-sync@0.32.0', '@jitl/quickjs-ffi-types@0.32.0'],
};
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
