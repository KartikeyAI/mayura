import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const dockerPath = process.env.MAYURA_DOCKER_CLI ?? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
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
await copyFile(join(workspace, 'packages', 'adapter-code-docker', 'image', 'Dockerfile'), join(output, 'Dockerfile'));
const tag = `mayura-code-sandbox:dev-${output.slice(-6).toLowerCase()}`;
await exec(dockerPath, ['build', '--pull=false', '--network=none', '--tag', tag, output], {
  cwd: workspace, windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1_024 * 1_024,
});
const inspected = await exec(dockerPath, ['image', 'inspect', '--format', '{{.Id}}', tag], { windowsHide: true, timeout: 10_000, maxBuffer: 4_096 });
const image = inspected.stdout.trim(); assert(/^sha256:[a-f0-9]{64}$/.test(image), 'Docker returned an invalid image ID.');
const report = { status: 'passed', node: process.version, platform: process.platform, architecture: process.arch, output, dockerPath, tag, image,
  base: 'node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5',
  packages: ['quickjs-emscripten-core@0.32.0', '@jitl/quickjs-wasmfile-release-sync@0.32.0', '@jitl/quickjs-ffi-types@0.32.0'],
};
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
