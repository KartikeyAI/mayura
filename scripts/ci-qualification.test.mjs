import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertQualification, QUALIFICATION_LANES } from './ci-qualification.mjs';

const successful = () => Object.fromEntries(QUALIFICATION_LANES.map(lane => [lane, { result: 'success', outputs: {} }]));
test('the gate covers every qualification job group in the workflow', () => {
  const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = source.split(/^jobs:\s*$/mu)[1];
  const ids = [...jobs.matchAll(/^  ([a-z][a-z0-9_-]*):\s*$/gmu)].map(match => match[1]);
  assert.deepEqual(ids.filter(id => id !== 'qualification').sort(), [...QUALIFICATION_LANES].sort());
  const gate = jobs.split(/^  qualification:\s*$/mu)[1];
  assert.match(gate, /if: \$\{\{ always\(\) \}\}/u);
  const dependencies = gate.match(/needs: \[([^\]]+)\]/u)[1].split(',').map(lane => lane.trim());
  assert.deepEqual(dependencies.sort(), [...QUALIFICATION_LANES].sort());
});

test('qualification requires every lane to succeed', () => {
  assert.doesNotThrow(() => assertQualification(successful()));
  for (const lane of QUALIFICATION_LANES) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      const needs = successful(); needs[lane].result = result;
      assert.throws(() => assertQualification(needs), /did not succeed/u);
    }
    const needs = successful(); delete needs[lane];
    assert.throws(() => assertQualification(needs));
  }
  for (const needs of [null, [], {}, { ...successful(), unexpected: { result: 'success' } }]) assert.throws(() => assertQualification(needs));
});

test('the gate command exits unsuccessfully for bad input and does not reveal outputs', () => {
  for (const needs of ['PRIVATE_INVALID_JSON', JSON.stringify({ ...successful(), tests: { result: 'failure', outputs: { private: 'PRIVATE_OUTPUT' } } })]) {
    const result = spawnSync(process.execPath, ['scripts/ci-qualification.mjs'], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, MAYURA_QUALIFICATION_NEEDS: needs },
    });
    assert.equal(result.status, 1);
    assert(!`${result.stdout}${result.stderr}`.includes('PRIVATE_'));
  }
  const result = spawnSync(process.execPath, ['scripts/ci-qualification.mjs'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, MAYURA_QUALIFICATION_NEEDS: JSON.stringify(successful()) },
  });
  assert.equal(result.status, 0);
});
