// Check the public documentation (docs/, README.md, llms.txt, AGENTS.md):
//   - every docs page has `title` and `description` frontmatter and is linked from a section of docs/README.md, and
//     llms.txt (generated from it by scripts/docs-index.mjs) is current;
//   - every relative link resolves (headings included), and docs pages link only within docs/ (the published site
//     and the copy inside the npm package contain nothing else);
//   - every TypeScript snippet type-checks against the real `mayura` entry points. Names a snippet leaves undeclared
//     (`model`, `runtime`, ...) are allowed, so snippets can stay short; imports, option names, required options and
//     types are all checked;
//   - every `mayura <command>` in a shell snippet is a real CLI command.
//     node scripts/docs-check.mjs [file ...]    (pnpm build first, so the entry points' declarations exist)
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { llmsTxt, navigation } from './docs-index.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(workspace, 'docs');
const posixPath = path => relative(workspace, path).split(sep).join('/');
const problems = [];
const problem = (file, line, message) => problems.push(`${posixPath(file)}${line ? `:${line}` : ''}: ${message}`);

const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith('.md') ? [join(directory, entry.name)] : []);
const pages = walk(docs).sort();
const extra = ['README.md', 'AGENTS.md', 'llms.txt'].map(name => join(workspace, name)).filter(existsSync);
const selected = process.argv.slice(2).map(path => resolve(path));
const checked = selected.length ? selected : [...pages, ...extra];

/** Lines of a Markdown file with fenced code blocks separated out. */
function parse(file) {
  const lines = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').split('\n');
  const prose = []; const blocks = []; let block;
  lines.forEach((text, index) => {
    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)(.*)$/u.exec(text);
    if (block) {
      if (fence && fence[2].startsWith(block.fence) && !fence[3]) { blocks.push(block); block = undefined; } else block.lines.push(text);
    } else if (fence) block = { fence: fence[2], language: fence[3].toLowerCase(), meta: fence[4].trim(), start: index + 2, lines: [] };
    else prose.push({ text, line: index + 1 });
  });
  if (block) problems.push(`${posixPath(file)}:${block.start - 1}: unclosed code block`);
  return { lines, prose, blocks };
}

/** GitHub's heading anchors. */
function anchors(file) {
  const seen = new Map(); const result = new Set();
  for (const { text } of parse(file).prose) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(text); if (!heading) continue;
    const base = heading[1].replace(/`/gu, '').replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1').trim().toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '').replace(/\s/gu, '-');
    const count = seen.get(base) ?? 0; seen.set(base, count + 1); result.add(count ? `${base}-${count}` : base);
  }
  return result;
}

// ---- Frontmatter, links and navigation ---------------------------------------------------------------------------

// Coding agents read AGENTS.md, CLAUDE.md and GEMINI.md as instructions for their folder, and on case-insensitive file
// systems (Windows, macOS) a page such as concepts/agents.md is that file, in this repository and in node_modules.
for (const page of pages) if (/^(?:agents|claude|gemini)\.md$/iu.test(page.split(sep).pop())) problem(page, 0, 'a coding agent would read this page as its instructions; rename it');

if (!selected.length) {
  // Navigation comes from docs/README.md (its sections and their links); llms.txt is generated from it.
  const listed = new Set(navigation().flatMap(section => section.pages.map(page => page.path)));
  for (const page of pages) if (page !== join(docs, 'README.md') && !listed.has(page)) problem(page, 0, 'not linked from a section of docs/README.md');
  const llms = join(workspace, 'llms.txt');
  if (!existsSync(llms) || readFileSync(llms, 'utf8').replaceAll('\r\n', '\n') !== llmsTxt()) problem(llms, 0, 'out of date; run node scripts/docs-index.mjs');
}

for (const file of checked) {
  const { lines, prose } = parse(file);
  const isPage = file.startsWith(docs + sep);
  if (isPage) {
    const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
    const front = end > 0 ? lines.slice(1, end) : [];
    for (const key of ['title', 'description']) {
      const entry = front.find(line => line.startsWith(`${key}:`));
      const value = entry?.slice(key.length + 1).trim().replace(/^"(.*)"$/u, '$1');
      if (!value) problem(file, 1, `missing frontmatter ${key}`);
      else if (key === 'description' && value.length > 200) problem(file, 1, 'description is longer than 200 characters');
    }
  }
  for (const { text, line } of prose) {
    const code = text.replace(/`[^`]*`/gu, '');
    for (const match of code.matchAll(/\]\(([^)\s]*)\)/gu)) {
      const target = match[1]; if (!target || /^(?:https?|mailto):/u.test(target)) continue;
      if (/^[a-z]+:/u.test(target)) { problem(file, line, `unexpected link scheme: ${target}`); continue; }
      const [path, hash] = target.split('#');
      const destination = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      if (/internal-docs/u.test(destination)) { problem(file, line, `links to internal documentation: ${target}`); continue; }
      if (isPage && !destination.startsWith(docs + sep)) { problem(file, line, `docs pages link only within docs/ (use a full URL): ${target}`); continue; }
      if (!existsSync(destination)) { problem(file, line, `broken link: ${target}`); continue; }
      if (hash && statSync(destination).isFile() && destination.endsWith('.md') && !anchors(destination).has(hash)) problem(file, line, `no heading #${hash} in ${posixPath(destination)}`);
    }
  }
}

// ---- Shell snippets: real CLI commands ---------------------------------------------------------------------------

const bin = readFileSync(join(workspace, 'packages', 'cli', 'src', 'bin.ts'), 'utf8');
const commands = new Set([...bin.matchAll(/command === '([a-z-]+)'/gu)].map(match => match[1]));
for (const name of ['--help', '-h', '--version', '-v']) commands.add(name);
for (const file of checked) for (const block of parse(file).blocks) {
  if (!['bash', 'sh', 'shell', 'console'].includes(block.language)) continue;
  block.lines.forEach((text, offset) => {
    const match = /^\s*(?:\$\s+)?(?:npx\s+(?:-y\s+)?|pnpm\s+(?:exec\s+|dlx\s+)?|npm\s+exec\s+(?:--\s+)?)?mayura(?:@\S+)?\s+(\S+)/u.exec(text);
    if (match && !commands.has(match[1]) && !match[1].startsWith('#')) problem(file, block.start + offset, `unknown CLI command: mayura ${match[1]}`);
  });
}

// ---- TypeScript snippets -------------------------------------------------------------------------------------------

// Undeclared names are the one thing a snippet may leave out; everything else is a real error.
const allowed = new Set([
  2304, // Cannot find name 'x'.
  2552, // Cannot find name 'x'. Did you mean 'y'?
  2582, 2593, // Cannot find name 'describe' / 'it' (test globals).
  18004, // No value exists in scope for the shorthand property 'x'.
]);
// Inside the workspace, so `mayura`, `zod` and `react` resolve as they do for a project; one folder per run.
const snippets = join(workspace, '.artifacts', `docs-snippets-${process.pid}`);
await rm(snippets, { recursive: true, force: true }); await mkdir(snippets, { recursive: true });
const origin = new Map(); let count = 0;
for (const file of checked) for (const block of parse(file).blocks) {
  if (!['ts', 'tsx', 'typescript'].includes(block.language)) continue;
  const name = `${posixPath(file).replace(/[^A-Za-z0-9]+/gu, '_')}_${block.start}.${block.language === 'tsx' ? 'tsx' : 'ts'}`;
  // Each snippet is its own module; `export {}` keeps it one even without imports.
  await writeFile(join(snippets, name), `${block.lines.join('\n')}\nexport {};\n`);
  origin.set(name, { file, start: block.start }); count += 1;
}
if (count) {
  await writeFile(join(snippets, 'package.json'), `${JSON.stringify({ type: 'module', private: true })}\n`);
  await writeFile(join(snippets, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: {
    strict: true, noImplicitAny: false, target: 'es2023', lib: ['es2023', 'dom'], module: 'nodenext', moduleResolution: 'nodenext',
    types: ['node'], jsx: 'react-jsx', noEmit: true, skipLibCheck: true }, include: ['*.ts', '*.tsx'] }, null, 2)}\n`);
  const tsc = join(workspace, 'node_modules', 'typescript', 'bin', 'tsc');
  assert(existsSync(join(workspace, 'packages', 'mayura', 'dist', 'index.d.ts')), 'Run pnpm build first: the snippets are checked against the built entry points.');
  let output = '';
  try { await promisify(execFile)(process.execPath, [tsc, '--project', join(snippets, 'tsconfig.json'), '--pretty', 'false'], { cwd: snippets, maxBuffer: 32 * 1_048_576, windowsHide: true }); }
  catch (error) { output = `${error.stdout ?? ''}${error.stderr ?? ''}`; if (!output.trim()) throw error; }
  for (const text of output.split(/\r?\n/u)) {
    const diagnostic = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/u.exec(text);
    if (!diagnostic) { if (text.trim() && !/^\s/u.test(text)) problems.push(`docs snippets: ${text.trim()}`); continue; }
    const [, path, line, , code, message] = diagnostic; const source = origin.get(path.split(/[\\/]/u).pop());
    if (allowed.has(Number(code))) continue;
    // Only `mayura` modules must resolve; a snippet may import the reader's own files and packages.
    if ((code === '2307' || code === '7016') && !/'mayura(?:\/[^']*)?'/u.test(message)) continue;
    if (!source) { problems.push(`docs snippets: ${text}`); continue; }
    problem(source.file, source.start + Number(line) - 1, `TS${code}: ${message}`);
  }
}

await rm(snippets, { recursive: true, force: true });
if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} documentation problem(s).`); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'passed', files: checked.length, pages: pages.length, snippets: count }));
