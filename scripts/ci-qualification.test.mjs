import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertQualification, QUALIFICATION_LANES } from './ci-qualification.mjs';

const results = ({ scope = 'full', website = 'false', websiteDocs = 'false' } = {}) => ({
  scope: { result: 'success', outputs: { scope, website, website_docs: websiteDocs } },
  website: { result: website === 'true' ? 'success' : 'skipped' },
  ...Object.fromEntries(QUALIFICATION_LANES.map(lane => [lane, { result: scope === 'full' ? 'success' : 'skipped' }])),
});
test('the gate covers every qualification job group in the workflow', () => {
  const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const [triggers, jobs] = source.split(/^jobs:\s*$/mu);
  assert.doesNotMatch(triggers, /^\s+paths(?:-ignore)?:/mu);
  const ids = [...jobs.matchAll(/^  ([a-z][a-z0-9_-]*):\s*$/gmu)].map(match => match[1]);
  const expected = ['scope', 'website', ...QUALIFICATION_LANES].sort();
  assert.deepEqual(ids.filter(id => id !== 'qualification').sort(), expected);
  for (const lane of QUALIFICATION_LANES) {
    const block = jobs.split(new RegExp(`^  ${lane}:$`, 'mu'))[1].split(/^  [a-z][a-z0-9_-]*:$/mu)[0];
    assert.match(block, /^    needs: scope$/mu);
    assert.match(block, /^    if: needs\.scope\.outputs\.scope == 'full'$/mu);
  }
  const website = jobs.split(/^  website:$/mu)[1].split(/^  [a-z][a-z0-9_-]*:$/mu)[0];
  assert.match(website, /^    if: needs\.scope\.outputs\.website == 'true'$/mu);
  assert.match(website, /uses: \.\/\.github\/actions\/check-site/u);
  assert.match(website, /run: pnpm build && pnpm docs:check/u);
  const gate = jobs.split(/^  qualification:\s*$/mu)[1];
  assert.match(gate, /^    name: Qualification gate$/mu);
  assert.match(gate, /if: \$\{\{ always\(\) \}\}/u);
  const dependencies = gate.match(/needs: \[([^\]]+)\]/u)[1].split(',').map(lane => lane.trim());
  assert.deepEqual(dependencies.sort(), expected);
});

test('full qualification requires every framework lane and any triggered website checks', () => {
  assert.equal(assertQualification(results()), 'full');
  assert.equal(assertQualification(results({ website: 'true', websiteDocs: 'true' })), 'full');
  for (const lane of QUALIFICATION_LANES) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      const needs = results(); needs[lane].result = result;
      assert.throws(() => assertQualification(needs), /must report success/u);
    }
    const needs = results(); delete needs[lane];
    assert.throws(() => assertQualification(needs));
  }
  const needs = results({ website: 'true' });
  needs.website.result = 'skipped';
  assert.throws(() => assertQualification(needs), /Website checks must report success/u);
});

test('website qualification requires a successful website job and explicitly skipped framework lanes', () => {
  const website = () => results({ scope: 'website', website: 'true' });
  assert.equal(assertQualification(website()), 'website');
  for (const result of ['skipped', 'failure', 'cancelled', undefined]) {
    const needs = website(); needs.website.result = result;
    assert.throws(() => assertQualification(needs), /Website checks must report success/u);
  }
  for (const result of ['success', 'failure', 'cancelled', undefined]) {
    const needs = website(); needs.tests.result = result;
    assert.throws(() => assertQualification(needs), /must report skipped/u);
  }
});

test('qualification fails closed on missing jobs or an invalid scope decision', () => {
  for (const needs of [null, [], {}, { ...results(), unexpected: { result: 'success' } }]) {
    assert.throws(() => assertQualification(needs));
  }
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    const needs = results(); needs.scope.result = result;
    assert.throws(() => assertQualification(needs), /detection did not succeed/u);
  }
  for (const needs of [results({ scope: 'unknown' }), results({ scope: 'website' }), results({ websiteDocs: 'true' })]) {
    assert.throws(() => assertQualification(needs), /Invalid change scope outputs/u);
  }
  const needs = results(); delete needs.scope.outputs.website_docs;
  assert.throws(() => assertQualification(needs), /Invalid change scope outputs/u);
});

test('the gate command exits unsuccessfully for bad input and does not reveal outputs', () => {
  for (const needs of ['PRIVATE_INVALID_JSON', JSON.stringify({ ...results(), tests: { result: 'failure', outputs: { private: 'PRIVATE_OUTPUT' } } })]) {
    const result = spawnSync(process.execPath, ['scripts/ci-qualification.mjs'], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, MAYURA_QUALIFICATION_NEEDS: needs },
    });
    assert.equal(result.status, 1);
    assert(!`${result.stdout}${result.stderr}`.includes('PRIVATE_'));
  }
  const result = spawnSync(process.execPath, ['scripts/ci-qualification.mjs'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, MAYURA_QUALIFICATION_NEEDS: JSON.stringify(results()) },
  });
  assert.equal(result.status, 0);
});
