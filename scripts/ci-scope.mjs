import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fallback = Object.freeze({ scope: 'full', website: true, website_docs: false });
const websiteDirectories = ['site/', 'docs/', 'extensions/ui/', 'packages/cli/ui/', '.github/actions/check-site/'];
const websiteFiles = new Set(['package.json', 'LICENSE', 'NOTICE', 'scripts/docs-index.mjs', 'scripts/ui-registry.mjs',
  '.github/workflows/site.yml']);
const qualificationBranches = new Set(['main', 'dev']);
const commitId = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value) && !/^0+$/u.test(value);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A verified diff can skip the matrix when it affects only the site or the commit history. */
export function classifyChangedPaths(paths) {
  return {
    scope: paths.every(path => path.startsWith('site/')) ? 'website' : 'full',
    website: paths.length === 0 || paths.some(path => websiteFiles.has(path) || websiteDirectories.some(directory => path.startsWith(directory))),
    website_docs: paths.some(path => path.startsWith('site/content/') || path.startsWith('site/snippets/')),
  };
}

function checkedBase(git, eventName, event, head) {
  if (eventName === 'pull_request') {
    const base = event?.pull_request?.base;
    const topic = event?.pull_request?.head;
    if (!commitId(base?.sha) || !commitId(topic?.sha) || !qualificationBranches.has(base.ref)) return;
    // The tested tree is GitHub's merge result. Its two parents must match the event's exact base and topic.
    const parents = git('rev-list', '--parents', '--max-count=1', head).toString('ascii').trim().split(' ');
    if (parents.length === 3 && parents[0] === head && parents[1] === base.sha && parents[2] === topic.sha) return base.sha;
    return;
  }
  if (!(event?.created === false && event.deleted === false && event.forced === false && event.after === head && event.before !== head
    && commitId(event.before) && typeof event.ref === 'string' && event.ref.startsWith('refs/heads/')
    && qualificationBranches.has(event.ref.slice('refs/heads/'.length)))) return;
  git('merge-base', '--is-ancestor', event.before, head);
  return event.before;
}

/** Unavailable Git objects, untrusted event metadata, and manual or merge-queue runs get full qualification. */
export function classifyCiScope(eventName, event, { cwd, expectedHead } = {}) {
  if (!['pull_request', 'push'].includes(eventName) || !commitId(expectedHead)) return fallback;
  const git = (...args) => execFileSync('git', args, {
    cwd, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const head = git('rev-parse', '--verify', 'HEAD^{commit}').toString('ascii').trim();
    if (head !== expectedHead) return fallback;
    const base = checkedBase(git, eventName, event, head);
    if (!base) return fallback;
    // Treat moves as a deletion and an addition so a move across the site boundary counts both paths.
    const changed = decoder.decode(git('diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', base, head, '--'));
    if (changed === '') return classifyChangedPaths([]);
    if (!changed.endsWith('\0')) return fallback;
    return classifyChangedPaths(changed.slice(0, -1).split('\0'));
  } catch {
    return fallback;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let event;
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { /* Fall back to the full matrix. */ }
  const result = classifyCiScope(process.env.GITHUB_EVENT_NAME, event, { expectedHead: process.env.GITHUB_SHA });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([name, value]) => `${name}=${value}\n`).join(''));
  }
  console.log(JSON.stringify(result));
}
