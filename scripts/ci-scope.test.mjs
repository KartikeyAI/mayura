import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { classifyChangedPaths, classifyCiScope } from './ci-scope.mjs';

const website = { scope: 'website', website: true, website_docs: false };
const full = { scope: 'full', website: false, website_docs: false };
const fullWithWebsite = { ...full, website: true };

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'mayura-ci-scope-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, content) => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const commit = message => {
    git('add', '--all');
    git('commit', '--no-gpg-sign', '--message', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--template=', '-b', 'main');
  git('config', 'user.email', 'tests@example.com');
  git('config', 'user.name', 'Mayura CI test');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', '.git/no-hooks');
  git('config', 'commit.gpgsign', 'false');
  write('packages/runtime.ts', 'export {};\n');
  write('site/content/home.md', 'Mayura\n');
  return { cwd, git, write, commit, initial: commit('Initial files') };
}

const push = (before, after) => ({ ref: 'refs/heads/dev', before, after, created: false, deleted: false, forced: false });

test('only the standalone website may use the fast path', () => {
  assert.deepEqual(classifyChangedPaths(['site/src/a component.tsx']), website);
  assert.deepEqual(classifyChangedPaths(['site/content/guides/new.md']), { ...website, website_docs: true });
  assert.deepEqual(classifyChangedPaths(['site/src/x.tsx', 'site/snippets/agent.ts']), { ...website, website_docs: true });
  assert.deepEqual(classifyChangedPaths(['packages/core/src/index.ts']), full);
  for (const path of ['docs/guides/agents.md', 'extensions/ui/src/index.ts', 'packages/cli/ui/example.tsx',
    'scripts/docs-index.mjs', 'scripts/ui-registry.mjs', 'package.json', 'LICENSE', 'NOTICE',
    '.github/workflows/site.yml', '.github/actions/check-site/action.yml']) {
    assert.deepEqual(classifyChangedPaths([path]), fullWithWebsite, path);
  }
  assert.deepEqual(classifyChangedPaths(['site/content/guides/new.md', 'docs/guides/agents.md']),
    { ...fullWithWebsite, website_docs: true });
  assert.deepEqual(classifyChangedPaths(['site-copy/example.md']), full);
  assert.deepEqual(classifyChangedPaths(['\uFEFFsite/content/guides/new.md']), full);
  assert.deepEqual(classifyChangedPaths([]), website);
});

test('push classification includes every commit in the exact push range', t => {
  const { cwd, write, commit, initial } = repository(t);
  write('packages/runtime.ts', 'export const version = 1;\n');
  const framework = commit('Change framework');
  write('site/src/banner.tsx', 'export const title = "Mayura";\n');
  const head = commit('Change website');
  const classify = event => classifyCiScope('push', event, { cwd, expectedHead: head });

  assert.deepEqual(classify(push(framework, head)), website);
  assert.deepEqual(classify(push(initial, head)), fullWithWebsite);
  assert.deepEqual(classify({ ...push(framework, head), forced: true }), fullWithWebsite);
  assert.deepEqual(classify({ ...push(framework, head), created: true }), fullWithWebsite);
  assert.deepEqual(classify({ ...push(framework, head), deleted: true }), fullWithWebsite);
  assert.deepEqual(classify(push(framework, initial)), fullWithWebsite);
  assert.deepEqual(classify(push(head, head)), fullWithWebsite);
  assert.deepEqual(classify(push('0'.repeat(40), head)), fullWithWebsite);
  assert.deepEqual(classify(push('a'.repeat(40), head)), fullWithWebsite);
  assert.deepEqual(classify({ ...push(framework, head), ref: 'refs/tags/v1.4.2' }), fullWithWebsite);
  assert.deepEqual(classifyCiScope('push', push(framework, head), { cwd, expectedHead: initial }), fullWithWebsite);
});

test('renaming framework source into the website still runs the framework matrix', t => {
  const { cwd, git, commit, initial } = repository(t);
  git('mv', 'packages/runtime.ts', 'site/runtime.ts');
  const head = commit('Move framework source into the website');
  assert.deepEqual(classifyCiScope('push', push(initial, head), { cwd, expectedHead: head }), fullWithWebsite);
});

test('a verified history sync with identical files uses the website checks on the PR and push', t => {
  const { cwd, git, initial } = repository(t);
  git('switch', '-c', 'release');
  git('commit', '--no-gpg-sign', '--allow-empty', '-m', 'Release marker');
  const release = git('rev-parse', 'HEAD');
  git('switch', 'main');
  git('merge', '--no-ff', '--no-edit', 'release');
  const head = git('rev-parse', 'HEAD');
  const event = { pull_request: { base: { ref: 'dev', sha: initial }, head: { sha: release } } };
  assert.deepEqual(classifyCiScope('pull_request', event, { cwd, expectedHead: head }), website);
  assert.deepEqual(classifyCiScope('push', push(initial, head), { cwd, expectedHead: head }), website);
});

test('a leading UTF-8 marker in a Git path is part of the filename', t => {
  const { cwd, write, commit, initial } = repository(t);
  write('\uFEFFsite/banner.md', 'This directory is outside site/.\n');
  const head = commit('Add lookalike path');
  assert.deepEqual(classifyCiScope('push', push(initial, head), { cwd, expectedHead: head }), full);
});

test('PR classification uses the checked-out merge result and both verified parents', t => {
  const { cwd, git, write, commit, initial } = repository(t);
  git('switch', '-c', 'topic');
  write('site/content/home.md', 'New copy\n');
  const topic = commit('Change website');
  git('switch', 'main');
  write('packages/runtime.ts', 'export const baseChange = true;\n');
  const base = commit('Update base branch');
  git('merge', '--no-ff', '--no-edit', 'topic');
  const head = git('rev-parse', 'HEAD');
  const event = { pull_request: { base: { ref: 'main', sha: base }, head: { sha: topic } } };
  const classify = payload => classifyCiScope('pull_request', payload, { cwd, expectedHead: head });

  assert.deepEqual(classify(event), { ...website, website_docs: true });
  assert.deepEqual(classify({ pull_request: { ...event.pull_request, base: { ref: 'main', sha: initial } } }), fullWithWebsite);
  assert.deepEqual(classify({ pull_request: { ...event.pull_request, head: { sha: initial } } }), fullWithWebsite);
  assert.deepEqual(classify({}), fullWithWebsite);
});

test('the CLI forces full qualification for manual runs and merge queues', t => {
  const { cwd, write, commit, initial } = repository(t);
  write('site/src/new.ts', 'export {};\n');
  const head = commit('Change website');
  write('push.json', JSON.stringify(push(initial, head)));
  const script = fileURLToPath(new URL('./ci-scope.mjs', import.meta.url));
  const classify = (eventName, eventPath) => {
    const output = join(cwd, `${eventName}.output`);
    execFileSync(process.execPath, [script], { cwd, env: { ...process.env, GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: join(cwd, eventPath), GITHUB_SHA: head, GITHUB_OUTPUT: output } });
    return readFileSync(output, 'utf8');
  };

  assert.equal(classify('push', 'push.json'), 'scope=website\nwebsite=true\nwebsite_docs=false\n');
  assert.equal(classify('workflow_dispatch', 'push.json'), 'scope=full\nwebsite=true\nwebsite_docs=false\n');
  assert.equal(classify('merge_group', 'push.json'), 'scope=full\nwebsite=true\nwebsite_docs=false\n');
  assert.equal(classify('pull_request', 'missing.json'), 'scope=full\nwebsite=true\nwebsite_docs=false\n');
});
