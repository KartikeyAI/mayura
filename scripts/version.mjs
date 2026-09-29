// Mayura's single version, kept in step across every package and every file that names it.
//   node scripts/version.mjs next [--version <x.y.z>]   the next release version from commits since the last v* tag
//   node scripts/version.mjs set <x.y.z>                 write it everywhere and move the changelog's Unreleased section
//                                                        (nothing to do when the code is already at that version)
//   node scripts/version.mjs check                       fail when any file disagrees with package.json (runs in CI)
//   node scripts/version.mjs notes <x.y.z>               print that version's changelog section (release notes)
//
// `next` follows Conventional Commits: a breaking change (`type!:` or a BREAKING CHANGE footer) is a major release
// (a minor one before 1.0), `feat` a minor one, `fix` and `perf` a patch; anything else releases nothing. From a
// prerelease such as 1.0.0-rc.1 it continues the prerelease (1.0.0-rc.2); release the final version explicitly.
// A requested version that is already tagged is a resume: allowed only when the code is at that version, so a release
// that stopped part-way (or one committed and tagged by hand) can finish its remaining steps.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const read = path => readFileSync(join(workspace, path), 'utf8');
const current = () => JSON.parse(read('package.json')).version;

/** Every file that names the version, besides the package manifests. Each must contain it exactly as package.json does. */
const mentions = [
  'packages/exporter-otlp/src/signals.ts', 'packages/exporter-otlp/src/otlp-http-json.ts',
  'packages/adapter-code-docker/image/Dockerfile', 'scripts/server-image.mjs', 'scripts/code-sandbox-image.mjs',
];
const manifests = () => ['package.json', ...readdirSync(join(workspace, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(workspace, 'packages', entry.name, 'package.json'))).map(entry => `packages/${entry.name}/package.json`)];

function parse(version) {
  const match = semver.exec(version); assert(match, `Not a semantic version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] };
}
function compare(left, right) {
  const a = parse(left); const b = parse(right);
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] - b[key];
  if (a.pre === b.pre) return 0; if (!a.pre) return 1; if (!b.pre) return -1;
  const x = a.pre.split('.'); const y = b.pre.split('.');
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined) return -1; if (y[index] === undefined) return 1;
    const numeric = /^\d+$/u.test(x[index]) && /^\d+$/u.test(y[index]);
    const order = numeric ? Number(x[index]) - Number(y[index]) : x[index].localeCompare(y[index]); if (order !== 0) return order;
  }
  return 0;
}
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
  const released = tags.map(tag => tag.slice(1)).filter(version => semver.test(version));
  if (released.includes(requested)) {
    assert.equal(at, requested, `v${requested} already exists and the code is at ${at}: resume a release only from code at its version.`);
    return 'resume';
  }
  const last = released.sort(compare).at(-1);
  assert(!last || compare(requested, last) > 0, `${requested} is not newer than the last release, v${last}.`);
  return 'new';
}

function next(requested) {
  const tags = git(['tag', '--list', 'v*']).split('\n').filter(tag => semver.test(tag.slice(1)));
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

function set(version) {
  parse(version); const old = current();
  // Resuming a release whose version is already committed: nothing to write, and the changelog stays as it is.
  if (version === old) { check(); console.log(JSON.stringify({ status: 'unchanged', version })); return; }
  for (const path of manifests()) {
    const text = read(path); const manifest = JSON.parse(text); if (manifest.version === undefined) continue;
    assert.equal(manifest.version, old, `${path} is at ${manifest.version}, not ${old}.`);
    writeFileSync(join(workspace, path), text.replace(`"version": "${old}"`, `"version": "${version}"`));
  }
  for (const path of mentions) {
    const text = read(path); assert(text.includes(old), `${path} does not name ${old}.`);
    writeFileSync(join(workspace, path), text.split(old).join(version));
  }
  const stability = JSON.parse(read('compatibility/api-stability.json')); stability.release = version;
  writeFileSync(join(workspace, 'compatibility/api-stability.json'), `${JSON.stringify(stability, null, 2)}\n`);
  // The Unreleased section becomes this release; a new, empty Unreleased section starts above it.
  const changelog = read('CHANGELOG.md'); const heading = /^## \[Unreleased\][^\n]*$/mu; assert(heading.test(changelog), 'CHANGELOG.md has no ## [Unreleased] section.');
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(join(workspace, 'CHANGELOG.md'), changelog.replace(heading, `## [Unreleased]\n\n## [${version}] - ${date}`));
  console.log(JSON.stringify({ status: 'set', from: old, version }));
}

function check() {
  const version = current(); parse(version); const problems = [];
  for (const path of manifests()) { const manifest = JSON.parse(read(path)); if (manifest.version !== undefined && manifest.version !== version) problems.push(`${path}: ${manifest.version}`); }
  for (const path of mentions) if (!read(path).includes(version)) problems.push(`${path} does not name ${version}`);
  if (JSON.parse(read('compatibility/api-stability.json')).release !== version) problems.push('compatibility/api-stability.json release');
  assert.deepEqual(problems, [], `Version ${version} is not used consistently:\n${problems.join('\n')}`);
  console.log(JSON.stringify({ status: 'consistent', version, files: manifests().length + mentions.length + 1 }));
}

function notes(version) {
  const changelog = read('CHANGELOG.md'); const start = changelog.indexOf(`## [${version}]`); assert(start >= 0, `CHANGELOG.md has no ${version} section.`);
  const body = changelog.slice(changelog.indexOf('\n', start) + 1); const end = body.search(/^## \[/mu);
  console.log((end < 0 ? body : body.slice(0, end)).trim() || `Mayura ${version}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, value] = process.argv.slice(2); const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  if (command === 'next') next(option('--version') || undefined);
  else if (command === 'set') set(value);
  else if (command === 'check') check();
  else if (command === 'notes') notes(value);
  else { console.error('Use: node scripts/version.mjs next [--version x.y.z] | set <x.y.z> | check | notes <x.y.z>'); process.exitCode = 1; }
}
