// The documentation's navigation and the files generated from it for AI assistants.
// docs/README.md is the one source of order: its `##` sections and the page links under them. Each page's title and
// description come from its frontmatter.
//   llms.txt       (repository root, committed; also in the package): the index, per https://llmstxt.org
//   llms-full.txt  (package only): every page in navigation order, in one file
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(workspace, 'docs');

/** A page's frontmatter fields and its body without them. */
export function readPage(path) {
  const text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  const fields = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const field = /^([A-Za-z]+):\s*(.*)$/u.exec(line); if (field) fields[field[1]] = field[2].trim().replace(/^"(.*)"$/u, '$1');
  }
  return { title: fields.title ?? '', description: fields.description ?? '', body: match ? text.slice(match[0].length) : text };
}

/** The sections of docs/README.md, each with the pages it links, in order; a page appears once, where first linked. */
export function navigation() {
  const index = join(docs, 'README.md'); const sections = []; const seen = new Set(); let inCode = false;
  for (const line of readFileSync(index, 'utf8').replaceAll('\r\n', '\n').split('\n')) {
    if (/^\s*(`{3,}|~{3,})/u.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading) { sections.push({ title: heading[1], pages: [] }); continue; }
    if (!sections.length) continue;
    for (const link of line.matchAll(/\]\(([^)#\s]+\.md)\)/gu)) {
      const path = resolve(docs, link[1]); if (seen.has(path) || !path.startsWith(docs + sep)) continue;
      seen.add(path); sections.at(-1).pages.push({ path, relative: relative(workspace, path).split(sep).join('/'), ...readPage(path) });
    }
  }
  return sections.filter(section => section.pages.length);
}

const summary = 'Mayura is a TypeScript framework for building AI agents, typed tools and durable workflows. It is one npm '
  + 'package, `mayura`: the root import is the core SDK (agents, tools, runtime) and every other part is a subpath such as '
  + '`mayura/provider-openai` or `mayura/workflows/lifecycle`. The `mayura` CLI creates, runs and operates projects.';
const rules = [
  'Import from `mayura` or `mayura/<entry point>`, never from `@mayura/...`.',
  'Nothing is allowed by default: grant `model:<adapter id>`, `tool:<tool id>`, `effect:<read|write|host>` and each tool capability in `createRuntime({ permissions: { allow } })`.',
  'Costs are in micros (1,000,000 = 1 US dollar). A run may spend nothing until `limits.maxCostMicros` is set; model adapters need prices and a per-call `maxCostMicros`.',
  'Mayura generates the JSON Schemas providers need from Zod schemas; providers accept only strict ones, so use `.nullable()`, not `.optional()`, for fields a model may leave empty.',
  'Check `result.status` before reading `result.output`; `outcome_unknown` means reconcile, not retry.',
  'Test offline with `scriptedModel` from `mayura/testing`.',
];

/** llms.txt. `full` adds the link to llms-full.txt, which exists only in the published package. */
export function llmsTxt({ full = false } = {}) {
  const lines = ['# Mayura', '', `> ${summary}`, '', 'Rules that matter when writing Mayura code:', '', ...rules.map(rule => `- ${rule}`), ''];
  for (const section of navigation()) {
    lines.push(`## ${section.title}`, '');
    for (const page of section.pages) lines.push(`- [${page.title}](${page.relative})${page.description ? `: ${page.description}` : ''}`);
    lines.push('');
  }
  if (full) lines.push('## Optional', '', '- [All of the documentation in one file](llms-full.txt)', '');
  return lines.join('\n');
}

/** llms-full.txt: every page, in navigation order, with its source path so links can be followed. */
export function llmsFullTxt() {
  const parts = [`# Mayura documentation\n\n> ${summary}\n`];
  for (const section of navigation()) for (const page of section.pages) {
    parts.push(`\n---\n\n# ${page.title}\n\nSource: ${page.relative}\n\n${page.description ? `${page.description}\n\n` : ''}${page.body.trim()}\n`);
  }
  return parts.join('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(workspace, 'llms.txt'), llmsTxt());
  console.log(JSON.stringify({ status: 'written', file: 'llms.txt', pages: navigation().reduce((total, section) => total + section.pages.length, 0) }));
}
