import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defineTool, type AnyTool } from 'mayura';
import { confirmBeforeRunning } from 'mayura/terminal';
import { z } from 'zod';

// The assistant's file tools, confined to one folder (the workspace). This is the whole safety story of the tools, so
// it is written to be read:
// - Paths are relative to the workspace. Absolute paths, `..` that leaves it, and symbolic links that lead out of it are
//   refused, by checking the real path on disk, not just the text.
// - Secrets and machinery are never read, listed or written: `.env` files, `.git` and `node_modules`.
// - Everything is bounded: file sizes, listing sizes and search work.
// - Writing is the only tool that changes anything, and a person at the terminal confirms every write first
//   (`confirmBeforeRunning`). With nobody at a terminal (piped, scripted), writes are refused.
// Tools answer ordinary problems ("no such file") with a result the model can read, instead of throwing: a failed
// tool call would end the turn.

const MAX_READ_BYTES = 64 * 1_024;
const MAX_WRITE_BYTES = 256 * 1_024;
const MAX_ENTRIES = 200;
const MAX_MATCHES = 50;
const MAX_SEARCHED_FILES = 2_000;
const MAX_SEARCHED_BYTES = 256 * 1_024;

/** A path segment the assistant never touches. */
const off = (segment: string): boolean => segment === '.git' || segment === 'node_modules' || /^\.env(?:\..*)?$/iu.test(segment);

export type Resolved = { readonly ok: true; readonly absolute: string; readonly path: string } | { readonly ok: false; readonly reason: string };

/** Where a workspace-relative path points, or why it is refused. `forWrite` allows a file (and folders) that do not exist yet. */
export async function resolveInWorkspace(root: string, requested: string, forWrite = false): Promise<Resolved> {
  const text = requested.trim().replaceAll('\\', '/');
  if (!text || isAbsolute(text) || /^[A-Za-z]:/u.test(text)) return { ok: false, reason: 'Use a path relative to the workspace folder.' };
  const absolute = resolve(root, text);
  const path = relative(root, absolute).split(sep).join('/') || '.';
  if (path === '..' || path.startsWith('../')) return { ok: false, reason: 'That path is outside the workspace folder.' };
  if (path.split('/').some(off)) return { ok: false, reason: 'The assistant does not open .env files, .git or node_modules.' };
  // The real location must still be inside the workspace: a symbolic link must not lead out of it.
  let existing = absolute;
  while (!existsSync(existing)) { if (!forWrite) return { ok: false, reason: `There is no ${path} in the workspace.` }; existing = dirname(existing); }
  const real = await realpath(existing); const inside = relative(root, real);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { ok: false, reason: 'That path leads outside the workspace folder.' };
  return { ok: true, absolute, path };
}

/** Read at most `limit` bytes of a file; `null` when it is not UTF-8 text. */
async function readText(absolute: string, limit: number): Promise<{ readonly text: string; readonly truncated: boolean } | null> {
  const handle = await open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, limit));
    if (bytes.includes(0)) return null;
    // A cut may split a character at the end; decode leniently there, but refuse text that is not UTF-8 elsewhere.
    const text = new TextDecoder('utf-8', { fatal: bytesRead <= limit }).decode(bytes);
    return { text, truncated: bytesRead > limit };
  } catch { return null; } finally { await handle.close(); }
}

const relativePath = z.string().min(1).max(512).describe('A path relative to the workspace folder, such as "src" or "README.md". Use "." for the folder itself.');

export function workspaceTools(workspace: string): { readonly tools: readonly AnyTool[]; readonly permissions: readonly string[] } {
  const root = realpathSync(workspace);

  const list = defineTool({
    id: 'files.list', version: '1', effects: 'read', capabilities: [],
    description: 'List the files and folders in a folder of the workspace, with file sizes. Start with "." to see the top level.',
    input: z.strictObject({ path: relativePath }),
    output: z.union([
      z.strictObject({ found: z.literal(true), path: z.string(), entries: z.array(z.strictObject({ name: z.string(), kind: z.enum(['file', 'folder']), bytes: z.number().int().nullable() })), truncated: z.boolean() }),
      z.strictObject({ found: z.literal(false), path: z.string(), reason: z.string() }),
    ]),
    execute: async ({ path }) => {
      const target = await resolveInWorkspace(root, path);
      if (!target.ok) return { found: false as const, path, reason: target.reason };
      if (!(await stat(target.absolute)).isDirectory()) return { found: false as const, path: target.path, reason: `${target.path} is a file, not a folder; read it instead.` };
      const names = (await readdir(target.absolute, { withFileTypes: true })).filter(entry => !off(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
      const entries = [];
      for (const entry of names.slice(0, MAX_ENTRIES)) {
        const details = await lstat(join(target.absolute, entry.name));
        entries.push({ name: entry.name, kind: details.isDirectory() ? 'folder' as const : 'file' as const, bytes: details.isFile() ? details.size : null });
      }
      return { found: true as const, path: target.path, entries, truncated: names.length > MAX_ENTRIES };
    },
  });

  const read = defineTool({
    id: 'files.read', version: '1', effects: 'read', capabilities: [],
    description: `Read a text file in the workspace (up to ${MAX_READ_BYTES / 1_024} KiB; longer files are cut and marked truncated).`,
    input: z.strictObject({ path: relativePath }),
    output: z.union([
      z.strictObject({ found: z.literal(true), path: z.string(), content: z.string(), truncated: z.boolean() }),
      z.strictObject({ found: z.literal(false), path: z.string(), reason: z.string() }),
    ]),
    execute: async ({ path }) => {
      const target = await resolveInWorkspace(root, path);
      if (!target.ok) return { found: false as const, path, reason: target.reason };
      if (!(await stat(target.absolute)).isFile()) return { found: false as const, path: target.path, reason: `${target.path} is a folder; list it instead.` };
      const content = await readText(target.absolute, MAX_READ_BYTES);
      if (!content) return { found: false as const, path: target.path, reason: `${target.path} is not a text file.` };
      return { found: true as const, path: target.path, content: content.text, truncated: content.truncated };
    },
  });

  const search = defineTool({
    id: 'files.search', version: '1', effects: 'read', capabilities: [],
    description: `Find lines containing some text (case-insensitive) in the workspace's text files. Returns up to ${MAX_MATCHES} matches with file and line number.`,
    input: z.strictObject({ query: z.string().min(1).max(200).describe('The text to look for.') }),
    output: z.strictObject({ query: z.string(), matches: z.array(z.strictObject({ path: z.string(), line: z.number().int(), text: z.string() })), truncated: z.boolean(), filesSearched: z.number().int() }),
    execute: async ({ query }, context) => {
      const needle = query.toLowerCase(); const matches: { path: string; line: number; text: string }[] = [];
      let filesSearched = 0; let truncated = false;
      // Breadth-first over the workspace, never following links and skipping what the assistant may not open.
      const pending = [root];
      while (pending.length && !truncated) {
        if (context.signal.aborted) break;
        const folder = pending.shift()!;
        for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (off(entry.name) || entry.isSymbolicLink()) continue;
          const absolute = join(folder, entry.name);
          if (entry.isDirectory()) { pending.push(absolute); continue; }
          if (!entry.isFile()) continue;
          if (++filesSearched > MAX_SEARCHED_FILES) { truncated = true; break; }
          const content = await readText(absolute, MAX_SEARCHED_BYTES); if (!content) continue;
          const lines = content.text.split(/\r?\n/u);
          for (let index = 0; index < lines.length; index++) {
            if (!lines[index]!.toLowerCase().includes(needle)) continue;
            if (matches.length === MAX_MATCHES) { truncated = true; break; }
            matches.push({ path: relative(root, absolute).split(sep).join('/'), line: index + 1, text: lines[index]!.trim().slice(0, 300) });
          }
          if (truncated) break;
        }
      }
      return { query, matches, truncated, filesSearched: Math.min(filesSearched, MAX_SEARCHED_FILES) };
    },
  });

  const write = defineTool({
    id: 'files.write', version: '1', effects: 'write', capabilities: ['files:write'],
    description: 'Create or replace a text file in the workspace with the given content. Only when the person asks for it.',
    input: z.strictObject({ path: relativePath, content: z.string().max(MAX_WRITE_BYTES).describe('The complete new content of the file.') }),
    output: z.union([
      z.strictObject({ written: z.literal(true), path: z.string(), bytes: z.number().int(), created: z.boolean() }),
      z.strictObject({ written: z.literal(false), path: z.string(), reason: z.string() }),
    ]),
    execute: async ({ path, content }) => {
      const target = await resolveInWorkspace(root, path, true);
      if (!target.ok) return { written: false as const, path, reason: target.reason };
      const created = !existsSync(target.absolute);
      if (!created && !(await stat(target.absolute)).isFile()) return { written: false as const, path: target.path, reason: `${target.path} is a folder.` };
      await mkdir(dirname(target.absolute), { recursive: true });
      const handle = await open(target.absolute, 'w');
      try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
      return { written: true as const, path: target.path, bytes: Buffer.byteLength(content), created };
    },
  });

  // What the person sees before they allow a write: the file, whether it is new, and the start of the new content.
  const confirmedWrite = confirmBeforeRunning(write, {
    describe: ({ path, content }) => {
      const lines = content.split(/\r?\n/u); const shown = lines.slice(0, 20).join('\n');
      const exists = existsSync(resolve(root, path.replaceAll('\\', '/')));
      return `${exists ? 'Replace' : 'Create'} ${path} (${Buffer.byteLength(content)} bytes)\n\n${shown}${lines.length > 20 ? `\n… ${lines.length - 20} more lines` : ''}`;
    },
  });

  const tools = [list, read, search, confirmedWrite];
  return { tools, permissions: ['tool:files.list', 'tool:files.read', 'tool:files.search', 'tool:files.write', 'files:write', 'effect:read', 'effect:write'] };
}
