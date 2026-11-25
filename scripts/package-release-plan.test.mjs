import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { compareReleaseVersions, readReleasePlan, releaseInventory, validateReleasePlan } from './package-release-plan.mjs';
import { prepareRelease, requestedRelease } from './version.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mayura-version-plan-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const write = (path, value) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const read = path => readFileSync(join(root, path), 'utf8');
  const manifestVersion = path => JSON.parse(read(path)).version;
  write('package.json', { name: 'mayura-workspace', version: '1.4.0' });
  write('packages/cli/package.json', { name: '@mayura/cli', private: true, version: '1.4.0' });
  write('extensions/provider/package.json', { name: '@mayurajs/provider', private: true, version: '1.4.0' });
  write('extensions/gateway/package.json', { name: '@mayurajs/gateway', private: true, version: '1.4.0',
    dependencies: { '@mayurajs/provider': 'workspace:*' } });
  write('compatibility/api-stability.json', { release: '1.4.0' });
  write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- A core fix.\n');
  for (const file of ['packages/exporter-otlp/src/signals.ts', 'packages/exporter-otlp/src/otlp-http-json.ts',
    'packages/adapter-code-docker/image/Dockerfile', 'scripts/code-sandbox-image.mjs']) write(file, '1.4.0\n');
  return { root, read, write, manifestVersion };
}

test('an extension-only version plan leaves the core, sibling archives and core changelog unchanged', t => {
  const { root, read, manifestVersion } = fixture(t);
  const before = read('CHANGELOG.md');
  const { path } = prepareRelease('provider-fix', 'Correct a provider edge case.', ['@mayurajs/provider@1.4.1'], { root });
  const plan = readReleasePlan(path, { root });

  assert.equal(path, 'release-plans/provider-fix.json');
  assert.equal(plan.path, path);
  assert.deepEqual(plan.plan.packages, [{ name: '@mayurajs/provider', version: '1.4.1' }]);
  assert.deepEqual(plan.tags, ['release/provider/v1.4.1']);
  assert.equal(plan.primaryTag, plan.tags[0]);
  assert.equal(plan.tag, 'latest');
  assert.equal(plan.digest, createHash('sha256').update(read(path)).digest('hex'));
  assert.equal(manifestVersion('package.json'), '1.4.0');
  assert.equal(manifestVersion('packages/cli/package.json'), '1.4.0');
  assert.equal(manifestVersion('extensions/gateway/package.json'), '1.4.0');
  assert.equal(read('CHANGELOG.md'), before);
});

test('a core-only plan keeps extension versions and updates bundled core metadata and changelog', t => {
  const { root, read, write, manifestVersion } = fixture(t);
  write('packages/cli/package.json', '{\r\n  "name": "@mayura/cli", "version": "1.4.0", "private": true\r\n}\r\n');
  write('CHANGELOG.md', read('CHANGELOG.md').replaceAll('\n', '\r\n'));
  const { path } = prepareRelease('core-fix', 'Correct the starter.', ['mayura@1.4.1'], { root, date: '2026-11-25' });
  const plan = readReleasePlan(path, { root });

  assert.deepEqual(plan.tags, ['v1.4.1']);
  assert.equal(manifestVersion('packages/cli/package.json'), '1.4.1');
  assert.match(read('packages/cli/package.json'), /"name": "@mayura\/cli", "version": "1\.4\.1", "private": true\r\n/u);
  assert.equal(manifestVersion('extensions/provider/package.json'), '1.4.0');
  assert.equal(manifestVersion('extensions/gateway/package.json'), '1.4.0');
  assert.match(read('CHANGELOG.md'), /## \[1\.4\.1\] - 2026-11-25\r\n\r\n- A core fix/);
  assert.equal(JSON.parse(read('compatibility/api-stability.json')).release, '1.4.1');
});

test('the workflow can read a plan from a fresh checkout before installing dependencies', t => {
  const { root, write } = fixture(t);
  for (const file of ['extensions.mjs', 'package-release-plan.mjs']) {
    write(`scripts/${file}`, readFileSync(new URL(file, import.meta.url), 'utf8'));
  }
  const { path } = prepareRelease('provider-fix', 'Correct a provider edge case.', ['@mayurajs/provider@1.4.1'], { root });
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/package-release-plan.mjs', path], { cwd: root, encoding: 'utf8' }));

  assert.deepEqual(result.packages, [{ name: '@mayurajs/provider', version: '1.4.1' }]);
  assert.equal(result.tag, 'latest');
});

test('batch plans canonicalize core-first dependency order with distinct versions', t => {
  const { root } = fixture(t);
  const { path } = prepareRelease('mixed', 'Core and both adapters.',
    ['@mayurajs/gateway@1.5.0', 'mayura@1.4.1', '@mayurajs/provider@1.4.2'], { root });
  const plan = readReleasePlan(path, { root });

  assert.deepEqual(plan.plan.packages, [
    { name: 'mayura', version: '1.4.1' },
    { name: '@mayurajs/provider', version: '1.4.2' },
    { name: '@mayurajs/gateway', version: '1.5.0' },
  ]);
  assert.deepEqual(plan.tags, ['v1.4.1', 'release/provider/v1.4.2', 'release/gateway/v1.5.0']);
  assert.equal(plan.primaryTag, 'v1.4.1');
  assert.throws(() => validateReleasePlan({ ...plan.plan, packages: [...plan.plan.packages].reverse() }, plan.inventory), /dependency order/);
});

test('stale, traversing, mixed-channel and invalid plans fail before writing another version', t => {
  const { root, manifestVersion, write } = fixture(t);
  assert.throws(() => prepareRelease('mixed', 'A release.', ['mayura@1.4.2', '@mayurajs/provider@1.5.0-rc.1'], { root }), /separate release plans/);
  assert.throws(() => prepareRelease('rollback', 'A release.', ['@mayurajs/provider@1.3.5'], { root }), /must be newer/);
  assert.throws(() => prepareRelease('../outside', 'A release.', ['mayura@1.4.1'], { root }), /plan ID/);
  assert.throws(() => prepareRelease('unsafe\n', 'A release.', ['mayura@1.4.1'], { root }), /plan ID/);
  assert.throws(() => prepareRelease('oversized', '\u0001'.repeat(48 * 1024), ['mayura@1.4.1'], { root }), /plan is too large/);
  assert.throws(() => prepareRelease('invalid', 'A release.', ['unknown@2.0.0'], { root }), /Unknown package/);
  assert.equal(existsSync(join(root, 'release-plans')), false);
  assert.equal(manifestVersion('package.json'), '1.4.0');
  assert.equal(manifestVersion('extensions/provider/package.json'), '1.4.0');
  assert.throws(() => readReleasePlan('unreviewed.json', { root }), /must be release-plans/);
  write('release-plans/stale.json', { format: 1, notes: 'Older package.',
    packages: [{ name: '@mayurajs/provider', version: '1.3.5' }] });
  assert.throws(() => readReleasePlan('release-plans/stale.json', { root }), /differs from source/);
  const inventory = releaseInventory(root);
  assert.throws(() => validateReleasePlan({ format: 1, notes: 'Wrong data.', packages: [inventory[0], inventory[0]] }, inventory), /Duplicate release package/);
  assert.throws(() => validateReleasePlan({ format: 1, notes: 'Wrong data.', packages: [inventory[0]], unexpected: true }, inventory), /Unexpected release plan fields/);
});

test('prerelease tags and version comparisons follow SemVer precedence', () => {
  assert(compareReleaseVersions('1.5.0-rc.2', '1.5.0-rc.10') < 0);
  assert(compareReleaseVersions('1.5.0-rc.1', '1.5.0-rc.abc') < 0);
  assert(compareReleaseVersions('1.5.0-rc.9', '1.5.0') < 0);
  assert.throws(() => compareReleaseVersions('1.5.0-rc.01', '1.5.0'), /Invalid npm release version/);
  assert.throws(() => compareReleaseVersions('1.5.0\n', '1.5.0'), /Invalid npm release version/);
  const entry = { name: '@mayurajs/provider', version: '1.5.0-rc.2' };
  const release = validateReleasePlan({ format: 1, notes: 'Try the candidate.', packages: [entry] },
    [{ name: 'mayura', version: '1.4.0' }, entry]);
  assert.deepEqual(release, { tag: 'next', tags: ['release/provider/v1.5.0-rc.2'], primaryTag: 'release/provider/v1.5.0-rc.2' });
  assert.throws(() => requestedRelease('1.5.0-rc.2', { tags: ['v1.5.0-rc.10'], current: '1.5.0-rc.2' }), /not newer/);
});
