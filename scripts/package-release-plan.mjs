// A version PR commits the explicit npm inventory for one publishing run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensions } from './extensions.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageName = /^(?:mayura|@mayurajs\/[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const planId = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const maxPlanBytes = 256 * 1024;

/** The exact npm versions supported by the release tooling, without build metadata. */
export function parseReleaseVersion(version) {
  const match = typeof version === 'string' && version.length <= 128 && semver.exec(version);
  assert(match && match[0] === version && (match[4] ?? '').split('.').every(part => !/^0\d+$/u.test(part)),
    'Invalid npm release version.');
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  assert([major, minor, patch].every(Number.isSafeInteger), 'Release version components exceed the safe integer limit.');
  return { major, minor, patch, pre: match[4] };
}

/** Compare exact versions rather than sorting prerelease or multi-digit components as strings. */
export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] - b[key];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const x = a.pre.split('.');
  const y = b.pre.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    if (x[i] === y[i]) continue;
    const xNumeric = /^\d+$/u.test(x[i]);
    const yNumeric = /^\d+$/u.test(y[i]);
    if (xNumeric && yNumeric) return BigInt(x[i]) < BigInt(y[i]) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Public package identities, with dependencies ahead of dependents. */
export function releaseInventory(root = workspace) {
  const core = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(core.name, 'mayura-workspace', 'Root package identity changed.');
  const inventory = [{ name: 'mayura', version: core.version }, ...extensions(root).map(({ name, manifest }) => {
    assert.equal(manifest.name, `@mayurajs/${name}`, 'Extension name must match its directory.');
    assert.equal(manifest.private, true, `Source manifest is public: ${manifest.name}.`);
    return { name: manifest.name, version: manifest.version };
  })];
  for (const { name, version } of inventory) {
    assert(packageName.exec(name)?.[0] === name, `Invalid public package name: ${name}.`);
    parseReleaseVersion(version);
  }
  return inventory;
}

/** Extension versions have their own source tags. Preserve the existing vX convention for the core. */
export function releaseTag(name, version) {
  assert(typeof name === 'string' && packageName.exec(name)?.[0] === name, 'Invalid public package name.');
  parseReleaseVersion(version);
  return name === 'mayura' ? `v${version}` : `release/${name.slice('@mayurajs/'.length)}/v${version}`;
}

export function releasePlanPath(id) {
  assert(typeof id === 'string' && planId.exec(id)?.[0] === id, 'Release plan ID must use lowercase letters, numbers and hyphens.');
  return `release-plans/${id}.json`;
}

export function encodeReleasePlan(plan) {
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  assert(bytes.length <= maxPlanBytes, 'Release plan is too large.');
  return bytes;
}

function exactFields(object, fields) {
  assert(object && typeof object === 'object' && !Array.isArray(object), 'Expected a release plan object.');
  assert.deepEqual(Object.keys(object).sort(), fields, 'Unexpected release plan fields.');
}

/** Validate a selected inventory against exact, reviewed source versions and dependency order. */
export function validateReleasePlan(plan, inventory) {
  exactFields(plan, ['format', 'notes', 'packages']);
  assert.equal(plan.format, 1, 'Unsupported release plan format.');
  assert(typeof plan.notes === 'string' && plan.notes.trim().length > 0
    && Buffer.byteLength(plan.notes) <= 96 * 1024 && !plan.notes.includes('\0'), 'Release plan needs bounded Markdown notes.');
  assert(Array.isArray(plan.packages) && plan.packages.length > 0, 'Release plan must select at least one package.');
  assert(inventory[0]?.name === 'mayura', 'Release inventory must begin with the core.');
  const versions = new Map(inventory.map(({ name, version }) => [name, version]));
  assert.equal(versions.size, inventory.length, 'Duplicate source package names.');
  const selected = new Set();
  const tags = [];
  let tag;
  for (const entry of plan.packages) {
    exactFields(entry, ['name', 'version']);
    assert(typeof entry.name === 'string' && versions.has(entry.name), `Unknown release package: ${entry.name}.`);
    assert(!selected.has(entry.name), `Duplicate release package: ${entry.name}.`);
    assert.equal(entry.version, versions.get(entry.name), `Selected version differs from source: ${entry.name}.`);
    selected.add(entry.name);
    const channel = parseReleaseVersion(entry.version).pre ? 'next' : 'latest';
    tag ??= channel;
    assert.equal(channel, tag, 'Stable and prerelease versions need separate release plans.');
    tags.push(releaseTag(entry.name, entry.version));
  }
  assert.deepEqual([...selected], inventory.filter(entry => selected.has(entry.name)).map(entry => entry.name),
    'Selected packages must follow source dependency order.');
  return { tags, tag, primaryTag: tags[0] };
}

/** Bind the release to the exact bytes of its reviewed, regular file. */
export function readReleasePlan(path, { root = workspace, inventory = releaseInventory(root) } = {}) {
  assert(typeof path === 'string' && path.length > 0, 'A plan path under release-plans/ is required.');
  const target = resolve(root, path);
  const logicalPath = relative(root, target).replaceAll('\\', '/');
  const match = /^release-plans\/([a-z0-9][a-z0-9-]{0,62})\.json$/u.exec(logicalPath);
  assert(match && logicalPath === releasePlanPath(match[1]), 'A plan path must be release-plans/<id>.json.');
  assert(lstatSync(dirname(target)).isDirectory(), 'Release plan directory must be a real directory.');
  const stats = lstatSync(target);
  assert(stats.isFile() && stats.size <= maxPlanBytes, 'Release plan must be a bounded, regular file.');
  const bytes = readFileSync(target);
  assert(bytes.length <= maxPlanBytes, 'Release plan is too large.');
  const plan = JSON.parse(bytes.toString('utf8'));
  const { tags, tag, primaryTag } = validateReleasePlan(plan, inventory);
  return { plan, path: logicalPath, digest: createHash('sha256').update(bytes).digest('hex'), tags, inventory,
    id: match[1], tag, primaryTag };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [path, ...extra] = process.argv.slice(2);
    assert(path && extra.length === 0, 'Use: node scripts/package-release-plan.mjs release-plans/<id>.json');
    const { id, tag, primaryTag, digest, tags, plan } = readReleasePlan(path);
    const outputs = { id, tag, primaryTag, digest };
    if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(outputs)) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
    console.log(JSON.stringify({ ...outputs, tags, packages: plan.packages }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
