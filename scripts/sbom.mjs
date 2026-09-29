// Generate a CycloneDX 1.5 SBOM for every workspace package and its production dependency closure, and review
// licences: every component must declare one, and strong-copyleft or source-available licences fail the build.
//   node scripts/sbom.mjs [--output path]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Global installs live in <bin>/node_modules on Windows but <prefix>/lib/node_modules on Linux and macOS; a PATH
// shim resolves to the real entry point. MAYURA_PNPM_CLI overrides the search.
const pnpm = (() => {
  if (process.env.MAYURA_PNPM_CLI) return existsSync(process.env.MAYURA_PNPM_CLI) ? process.env.MAYURA_PNPM_CLI : undefined;
  const directories = [...new Set([dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)])];
  const candidates = ['pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js'].flatMap(suffix => directories.flatMap(directory =>
    [join(directory, 'node_modules', suffix), resolve(directory, '..', 'lib', 'node_modules', suffix)]));
  for (const directory of directories) { try { const shim = realpathSync(join(directory, 'pnpm')); if (/\.(?:c?js|mjs)$/.test(shim)) candidates.push(shim); } catch { /* next entry */ } }
  return candidates.find(existsSync);
})();
assert(pnpm, 'Could not locate the local pnpm CLI.');
const projects = JSON.parse(execFileSync(process.execPath, [pnpm, 'ls', '-r', '--prod', '--json', '--depth', 'Infinity'],
  { cwd: workspace, encoding: 'utf8', maxBuffer: 128 * 1_048_576 }));
const denied = /\b(?:A?GPL|LGPL|SSPL|BUSL|Commons-Clause|Elastic-2\.0)\b/i;
const purl = (name, version) => `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
const components = new Map(); const edges = new Map(); const findings = [];
const license = path => {
  try { const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    return typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? null; } catch { return null; }
};
// Optional packages with a prebuilt binary for another platform are not installed here, so their manifests cannot be
// read. Each licence below was checked on the registry for that exact version; a new version needs a new review.
const reviewedLicences = new Map([
  ...['darwin-arm64', 'darwin-x64', 'linux-arm-gnueabihf', 'linux-arm-musleabihf', 'linux-arm64-gnu', 'linux-arm64-musl', 'linux-x64-gnu', 'linux-x64-musl', 'win32-x64-msvc']
    .map(platform => [`@libsql/${platform}@0.5.29`, 'MIT']),
]);
const visit = (name, node, parentRef) => {
  const ref = purl(name, node.version); if (parentRef) edges.get(parentRef).add(ref);
  if (!components.has(ref)) {
    const installed = typeof node.path === 'string' && existsSync(join(node.path, 'package.json'));
    const declared = installed ? license(node.path) : reviewedLicences.get(`${name}@${node.version}`) ?? null;
    if (!declared) findings.push({ component: ref, problem: 'no declared licence' });
    else if (denied.test(declared)) findings.push({ component: ref, problem: `licence not permitted in production dependencies: ${declared}` });
    components.set(ref, { type: 'library', 'bom-ref': ref, name, version: node.version, purl: ref, ...(declared ? { licenses: [{ expression: declared }] } : {}) });
    edges.set(ref, new Set());
    for (const [child, value] of Object.entries(node.dependencies ?? {})) visit(child, value, ref);
  }
};
for (const project of projects) {
  // Mayura's own packages: the ones bundled into mayura, and the @mayurajs extensions published beside it.
  const own = project.name?.startsWith('@mayura/') || project.name?.startsWith('@mayurajs/');
  if (!own || project.name === '@mayura/consumer-tests') continue;
  const ref = purl(project.name, project.version);
  components.set(ref, { type: 'library', 'bom-ref': ref, name: project.name, version: project.version, purl: ref, licenses: [{ expression: 'Apache-2.0' }] });
  edges.set(ref, new Set());
  for (const [child, value] of Object.entries(project.dependencies ?? {})) {
    if (child.startsWith('@mayura/') || child.startsWith('@mayurajs/') || child === 'mayura') edges.get(ref).add(purl(child, value.version)); else visit(child, value, ref);
  }
}
const root = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
const sbom = { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
  metadata: { timestamp: new Date().toISOString(), tools: { components: [{ type: 'application', name: 'mayura-sbom', version: '1' }] },
    component: { type: 'framework', 'bom-ref': 'pkg:generic/mayura', name: 'mayura', version: root.version, licenses: [{ expression: 'Apache-2.0' }] } },
  components: [...components.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
  dependencies: [...edges.entries()].map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() })).sort((a, b) => a.ref.localeCompare(b.ref)) };
const argument = process.argv.indexOf('--output');
if (argument < 0) await mkdir(join(workspace, '.artifacts'), { recursive: true }); // gitignored: absent in a fresh checkout
const output = argument >= 0 ? resolve(process.argv[argument + 1]) : join(await mkdtemp(join(workspace, '.artifacts', 'sbom-')), 'sbom.cdx.json');
await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`);
const licences = {}; for (const component of components.values()) { const key = component.licenses?.[0]?.expression ?? 'UNDECLARED'; licences[key] = (licences[key] ?? 0) + 1; }
console.log(JSON.stringify({ status: findings.length ? 'failed' : 'passed', components: components.size, thirdParty: [...components.keys()].filter(ref => !ref.startsWith('pkg:npm/%40mayura/') && !ref.startsWith('pkg:npm/%40mayurajs/')).length,
  licences, findings, sbom: relative(workspace, output) }));
if (findings.length) process.exitCode = 1;
