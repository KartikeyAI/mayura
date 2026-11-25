// Prepare the package versions and publish inventory for a reviewed release PR.
// `prepare <id> --notes <file> <name@version>...` versions only the selected public packages.
// `next`, `set --lockstep` and `notes` support the historical coordinated release workflow.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSource, extensions } from './extensions.mjs';
import { compareReleaseVersions as compare, encodeReleasePlan, parseReleaseVersion as parse, releaseInventory, releasePlanPath, validateReleasePlan } from './package-release-plan.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path, root = workspace) => readFileSync(join(root, path), 'utf8');
const current = () => JSON.parse(read('package.json')).version;

/** Every file that names the version, besides the package manifests. Each must contain it exactly as package.json does. */
const mentions = [
  'packages/exporter-otlp/src/signals.ts', 'packages/exporter-otlp/src/otlp-http-json.ts',
  'packages/adapter-code-docker/image/Dockerfile', 'scripts/code-sandbox-image.mjs',
];
/** The published core is assembled from the root and its private workspace packages. */
function coreManifests(root) {
  const directory = join(root, 'packages');
  const packages = existsSync(directory) ? readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, 'package.json')))
    .map(entry => `packages/${entry.name}/package.json`) : [];
  return ['package.json', ...packages];
}

const isVersion = version => {
  try { parse(version); return true; } catch { return false; }
};
const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();

/** The bump the commits since `since` call for: 'major', 'minor', 'patch' or undefined. */
export function bumpFor(messages) {
  let bump;
  for (const message of messages) {
    const subject = message.split('\n')[0] ?? '';
    if (/^chore\(release\)/u.test(subject)) continue;
    const header = /^([a-z]+)(\([^)]*\))?(!)?:/u.exec(subject); if (!header) continue;
    if (header[3] || /^BREAKING[ -]CHANGE:/mu.test(message)) return 'major';
    if (header[1] === 'feat') bump = 'minor';
    else if ((header[1] === 'fix' || header[1] === 'perf') && bump !== 'minor') bump = 'patch';
  }
  return bump;
}
export function nextVersion(last, bump) {
  if (!bump) return undefined;
  const { major, minor, patch, pre } = parse(last);
  if (pre) { const parts = pre.split('.'); const count = /^\d+$/u.test(parts.at(-1)) ? Number(parts.pop()) + 1 : 1; return `${major}.${minor}.${patch}-${[...parts, count].join('.')}`; }
  if (bump === 'major') return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Whether an explicitly requested version may be released, given the existing `v*` tags and the code's version:
 * `new` for a version newer than every tag, `resume` for one already tagged whose version the code is at. Throws
 * otherwise, saying why.
 */
export function requestedRelease(requested, { tags, current: at }) {
  parse(requested);
  const released = tags.filter(tag => tag.startsWith('v')).map(tag => tag.slice(1)).filter(isVersion);
  if (released.includes(requested)) {
    assert.equal(at, requested, `v${requested} already exists and the code is at ${at}: resume a release only from code at its version.`);
    return 'resume';
  }
  const last = released.sort(compare).at(-1);
  assert(!last || compare(requested, last) > 0, `${requested} is not newer than the last release, v${last}.`);
  return 'new';
}

function next(requested) {
  const tags = git(['tag', '--list', 'v*']).split('\n').filter(tag => isVersion(tag.slice(1)));
  const last = tags.map(tag => tag.slice(1)).sort(compare).at(-1);
  let version; let reason;
  if (requested) {
    reason = requestedRelease(requested, { tags, current: current() }) === 'resume' ? `resume: v${requested} is already tagged; finishing its remaining steps` : 'requested';
    version = requested;
  } else if (!last) {
    reason = 'There is no v* release tag yet. Start the first release by hand with an explicit version, such as 1.0.0.';
  } else {
    const log = git(['log', `v${last}..HEAD`, '--format=%B%x00']).split('\0').map(item => item.trim()).filter(Boolean);
    version = nextVersion(last, bumpFor(log)); reason = version ? `${log.length} commits since v${last}` : `No feat, fix, perf or breaking commit since v${last}.`;
  }
  const result = { version: version ?? '', last: last ?? '', reason, tag: version ? (parse(version).pre ? 'next' : 'latest') : '' };
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${String(value).replace(/\n/gu, ' ')}\n`);
}

function manifestChange(root, path, old, version) {
  const before = read(path, root);
  assert.equal(JSON.parse(before).version, old, `${path} must be at ${old}.`);
  // Some manifests put name and version on the same line. Preserve their layout.
  const field = /((?:^|[,{])\s*"version"\s*:\s*)"[^"\\\r\n]+"/gu;
  assert.equal([...before.matchAll(field)].length, 1, `Expected one version field in ${path}.`);
  const after = before.replace(field, (_, prefix) => prefix + JSON.stringify(version));
  assert.equal(JSON.parse(after).version, version, `Could not update the version in ${path}.`);
  return { path, before, after };
}

function coreChanges(root, old, version, date) {
  const changes = coreManifests(root).filter(path => JSON.parse(read(path, root)).version !== undefined)
    .map(path => manifestChange(root, path, old, version));
  const update = (path, transform) => {
    const before = read(path, root);
    changes.push({ path, before, after: transform(before) });
  };
  for (const path of mentions) {
    update(path, text => {
      assert(text.includes(old), `${path} does not name ${old}.`);
      return text.split(old).join(version);
    });
  }
  update('compatibility/api-stability.json', text => {
    const policy = JSON.parse(text);
    assert.equal(policy.release, old, 'API stability metadata has a different core version.');
    return `${JSON.stringify({ ...policy, release: version }, null, 2)}\n`;
  });
  update('CHANGELOG.md', text => {
    const heading = /^## \[Unreleased\][^\r\n]*$/mu;
    const lineEnd = text.includes('\r\n') ? '\r\n' : '\n';
    assert(heading.test(text), 'CHANGELOG.md has no ## [Unreleased] section.');
    assert(!text.includes(`## [${version}]`), 'CHANGELOG.md already has this core release.');
    return text.replace(heading, `## [Unreleased]${lineEnd}${lineEnd}## [${version}] - ${date}`);
  });
  return changes;
}

/** Compute every edit first. Restore the files written by this invocation if preparation fails. */
function applyChanges(root, changes, finish = () => {}) {
  for (const { path, before } of changes) {
    assert(lstatSync(join(root, path)).isFile() && read(path, root) === before, `File changed during preparation: ${path}.`);
  }
  const written = [];
  try {
    for (const change of changes) {
      writeFileSync(join(root, change.path), change.after);
      written.push(change);
    }
    finish();
  } catch (error) {
    for (const { path, before, after } of written.reverse()) {
      if (read(path, root) === after) writeFileSync(join(root, path), before);
    }
    throw error;
  }
}

const extensionManifest = name => `extensions/${name.slice('@mayurajs/'.length)}/package.json`;

/** Apply a package-scoped version plan locally. The caller reviews and commits the files. */
export function prepareRelease(id, notes, specifications, { root = workspace, date = new Date().toISOString().slice(0, 10) } = {}) {
  const path = releasePlanPath(id);
  const target = join(root, path);
  assert(!existsSync(target), `Release plan already exists: ${path}.`);
  assert(Array.isArray(specifications) && specifications.length > 0, 'Select at least one name@version.');
  const inventory = releaseInventory(root);
  const versions = new Map(inventory.map(({ name, version }) => [name, version]));
  const selected = new Map();
  for (const specification of specifications) {
    const index = specification.lastIndexOf('@');
    assert(index > 0, `Expected name@version: ${specification}.`);
    const name = specification.slice(0, index);
    const version = specification.slice(index + 1);
    const previous = versions.get(name);
    assert(previous, `Unknown package: ${name}.`);
    assert(!selected.has(name), `Package selected twice: ${name}.`);
    assert(compare(version, previous) > 0, `${name}@${version} must be newer than ${previous}.`);
    selected.set(name, version);
  }
  const nextInventory = inventory.map(({ name, version }) => ({ name, version: selected.get(name) ?? version }));
  const plan = { format: 1, packages: nextInventory.filter(entry => selected.has(entry.name)), notes };
  validateReleasePlan(plan, nextInventory);
  const planBytes = encodeReleasePlan(plan);
  const changes = plan.packages.flatMap(({ name, version }) =>
    name === 'mayura' ? coreChanges(root, versions.get(name), version, date)
      : [manifestChange(root, extensionManifest(name), versions.get(name), version)]);
  mkdirSync(dirname(target), { recursive: true });
  assert(lstatSync(dirname(target)).isDirectory(), 'Release plan directory must be a real directory.');
  applyChanges(root, changes, () => writeFileSync(target, planBytes, { flag: 'wx' }));
  return { path, packages: plan.packages };
}

function set(version) {
  parse(version);
  const old = current();
  const publicExtensions = releaseInventory().slice(1);
  assert(publicExtensions.every(entry => entry.version === old), 'Legacy lockstep versioning requires a coordinated checkout.');
  if (version === old) { check(); console.log(JSON.stringify({ status: 'unchanged', version })); return; }
  const changes = coreChanges(workspace, old, version, new Date().toISOString().slice(0, 10));
  for (const { name } of publicExtensions) changes.push(manifestChange(workspace, extensionManifest(name), old, version));
  applyChanges(workspace, changes);
  console.log(JSON.stringify({ status: 'set', from: old, version }));
}

function check() {
  const version = current(); parse(version); const problems = [];
  const manifests = coreManifests(workspace);
  for (const path of manifests) { const manifest = JSON.parse(read(path)); if (manifest.version !== undefined && manifest.version !== version) problems.push(`${path}: ${manifest.version}`); }
  for (const path of mentions) if (!read(path).includes(version)) problems.push(`${path} does not name ${version}`);
  if (JSON.parse(read('compatibility/api-stability.json')).release !== version) problems.push('compatibility/api-stability.json release');
  assert.deepEqual(problems, [], `Version ${version} is not used consistently:\n${problems.join('\n')}`);
  const inventory = releaseInventory();
  for (const extension of extensions()) checkSource(extension, version);
  console.log(JSON.stringify({ status: 'consistent', version, files: manifests.length + mentions.length + inventory.length }));
}

function notes(version) {
  const changelog = read('CHANGELOG.md'); const start = changelog.indexOf(`## [${version}]`); assert(start >= 0, `CHANGELOG.md has no ${version} section.`);
  const body = changelog.slice(changelog.indexOf('\n', start) + 1); const end = body.search(/^## \[/mu);
  console.log((end < 0 ? body : body.slice(0, end)).trim() || `Mayura ${version}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'next' && (args.length === 0 || (args.length === 2 && args[0] === '--version'))) next(args[1] || undefined);
    else if (command === 'set' && args.length === 2 && args[1] === '--lockstep') set(args[0]);
    else if (command === 'check' && args.length === 0) check();
    else if (command === 'notes' && args.length === 1) notes(args[0]);
    else if (command === 'prepare' && args.length >= 4 && args[1] === '--notes') {
      console.log(JSON.stringify(prepareRelease(args[0], readFileSync(args[2], 'utf8').trim(), args.slice(3))));
    } else {
      throw new Error('Use: node scripts/version.mjs prepare <id> --notes <file> <name@version>... | next [--version x.y.z] | set <x.y.z> --lockstep | check | notes <x.y.z>');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
