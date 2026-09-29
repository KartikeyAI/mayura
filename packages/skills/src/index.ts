// Agent skills: named bundles of instructions (and optional reference files) that an agent loads only when a task
// needs them. Folders follow the open SKILL.md format: YAML front matter with `name` and `description`, then the
// instructions in Markdown, plus any other files the instructions refer to.
//
// An agent sees only each skill's name and description (the catalog). Two read-only tools load a skill's full
// instructions and read its files on demand, so dozens of skills cost little until one is used. Skills never grant
// permissions: a tool or script a skill mentions still needs its own grant, and this package never runs scripts.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { MayuraError, freezeJson, jsonValue, type JsonObject, type Schema } from '@mayura/core';
import { defineTool, type AnyTool } from '@mayura/tools';
import { sha256Hex } from '@mayura/core/host';

/** A file a skill bundles besides SKILL.md, by path relative to the skill folder (`references/api.md`). */
export interface SkillFile { readonly path: string; readonly bytes: number; readonly text: boolean }
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** The Markdown after the front matter: what the agent reads when it loads the skill. */
  readonly instructions: string;
  readonly files: readonly SkillFile[];
  readonly license?: string;
  /** Tools the skill expects (informational: it grants nothing). */
  readonly allowedTools: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
  /** SHA-256 over the skill's front matter, instructions and every file. */
  readonly digest: string;
}
export interface SkillSet {
  readonly skills: readonly Skill[];
  /** SHA-256 over every skill's digest; also the version of the skill tools, so durable runs pin what they read. */
  readonly digest: string;
  get(name: string): Skill | undefined;
  /** A skill file's text. Binary files are listed but not readable. */
  readFile(name: string, path: string): string;
  /** The block to add to an agent's instructions: how to use skills, and each skill's name and description. */
  catalog(): string;
  /** `skills.load` and `skills.read`: read-only tools with no effects. */
  readonly tools: readonly AnyTool[];
  /** What a runtime must allow for the tools: `tool:skills.load`, `tool:skills.read` and `skills:read`. */
  readonly permissions: readonly string[];
}
export interface SkillLimits {
  /** Skills in one set (default 64). */
  readonly maxSkills?: number;
  /** Files in one skill besides SKILL.md (default 128). */
  readonly maxFilesPerSkill?: number;
  /** Bytes in one file, SKILL.md included (default 256 KiB). */
  readonly maxFileBytes?: number;
  /** Bytes across all skills (default 16 MiB). */
  readonly maxTotalBytes?: number;
  /** Bytes of the catalog added to the agent's instructions (default 16 KiB). */
  readonly maxCatalogBytes?: number;
}

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const pathPattern = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const fail = (message: string): never => { throw new MayuraError('INVALID_CONFIG', message); };
const sha256 = (value: string | Uint8Array): string => sha256Hex(value);
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
function limits(options: SkillLimits = {}): Required<SkillLimits> {
  const pick = (value: number | undefined, fallback: number, name: string): number => {
    const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < 1) fail(`${name} must be a positive integer.`); return result;
  };
  return { maxSkills: pick(options.maxSkills, 64, 'maxSkills'), maxFilesPerSkill: pick(options.maxFilesPerSkill, 128, 'maxFilesPerSkill'),
    maxFileBytes: pick(options.maxFileBytes, 262_144, 'maxFileBytes'), maxTotalBytes: pick(options.maxTotalBytes, 16_777_216, 'maxTotalBytes'),
    maxCatalogBytes: pick(options.maxCatalogBytes, 16_384, 'maxCatalogBytes') };
}

/**
 * The front matter of SKILL.md: a small, strict YAML subset (`key: value`, quoted values, `>`/`|` block scalars, a
 * `metadata` map and an `allowed-tools` list). Unknown keys are ignored.
 */
export function parseSkillFile(text: string, label = 'SKILL.md'): { readonly fields: Record<string, unknown>; readonly body: string } {
  const normalized = text.replace(/^﻿/u, '').replace(/\r\n?/gu, '\n');
  if (!normalized.startsWith('---\n')) fail(`${label} must start with a --- front matter block.`);
  const end = normalized.indexOf('\n---', 4); if (end < 0) fail(`${label} front matter is not closed with ---.`);
  const after = normalized.slice(end + 4); if (after && !after.startsWith('\n')) fail(`${label} front matter must end with a --- line.`);
  const lines = normalized.slice(4, end).split('\n'); const fields: Record<string, unknown> = {};
  const scalar = (raw: string): string => {
    const value = raw.trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)) { try { return JSON.parse(value) as string; } catch { return fail(`${label}: invalid quoted value.`); } }
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replaceAll("''", "'");
    return value;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!; if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s(.*)|)$/u.exec(line); if (!match) fail(`${label}: cannot read front matter line ${index + 1}.`);
    const key = match![1]!; const rest = (match![2] ?? '').trim();
    const block: string[] = [];
    while (index + 1 < lines.length && (/^\s+\S/u.test(lines[index + 1]!) || lines[index + 1] === '')) block.push(lines[++index]!);
    if (rest === '>' || rest === '|' || rest === '>-' || rest === '|-') {
      const content = block.map(item => item.trim());
      fields[key] = rest.startsWith('>') ? content.filter(Boolean).join(' ') : content.join('\n').trim();
    } else if (rest === '' && block.some(item => item.trim().startsWith('- '))) {
      fields[key] = block.filter(item => item.trim()).map(item => { const entry = item.trim(); if (!entry.startsWith('- ')) fail(`${label}: ${key} mixes list and map entries.`); return scalar(entry.slice(2)); });
    } else if (rest === '' && block.length > 0) {
      const map: Record<string, string> = {};
      for (const item of block.filter(entry => entry.trim())) {
        const pair = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(item); if (!pair) fail(`${label}: cannot read ${key} entry "${item.trim()}".`);
        map[pair![1]!] = scalar(pair![2]!);
      }
      fields[key] = map;
    } else fields[key] = scalar(rest);
  }
  return { fields, body: after.replace(/^\n/u, '') };
}

/** Define a skill in code: the same shape a SKILL.md folder has. `files` maps relative paths to their text. */
export function defineSkill(options: { readonly name: string; readonly description: string; readonly instructions: string;
  readonly files?: Readonly<Record<string, string>>; readonly license?: string; readonly allowedTools?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>> }): Skill {
  const files = Object.entries(options.files ?? {}).map(([path, content]) => ({ path, content: new TextEncoder().encode(content) }));
  return build({ name: options.name, description: options.description, instructions: options.instructions, license: options.license,
    allowedTools: options.allowedTools, metadata: options.metadata, files }, `skill ${options.name}`).skill;
}

type Contents = ReadonlyMap<string, Uint8Array>;
const contents = new WeakMap<Skill, Contents>();
function build(input: { name: unknown; description: unknown; instructions: string; license?: unknown; allowedTools?: unknown; metadata?: unknown;
  files: readonly { path: string; content: Uint8Array }[] }, label: string): { skill: Skill; bytes: number } {
  const name = typeof input.name === 'string' ? input.name : fail(`${label} needs a name.`);
  if (name.length > 64 || !namePattern.test(name)) fail(`${label}: the name must be lower-case letters, digits and single hyphens, up to 64 characters.`);
  const description = typeof input.description === 'string' ? input.description.trim() : fail(`${label} needs a description.`);
  if (!description || description.length > 1_024) fail(`${label}: the description must be 1 to 1024 characters.`);
  if (typeof input.instructions !== 'string' || !input.instructions.trim()) fail(`${label} has no instructions.`);
  const license = input.license === undefined ? undefined : typeof input.license === 'string' && input.license.length <= 256 ? input.license : fail(`${label}: license must be text.`);
  const allowed = input.allowedTools === undefined ? [] : typeof input.allowedTools === 'string' ? input.allowedTools.split(/[\s,]+/u).filter(Boolean)
    : Array.isArray(input.allowedTools) && input.allowedTools.every(item => typeof item === 'string') ? input.allowedTools as string[] : fail(`${label}: allowed-tools must be a list.`);
  const metadata = input.metadata === undefined ? {} : input.metadata !== null && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    && Object.values(input.metadata).every(value => typeof value === 'string') ? input.metadata as Record<string, string> : fail(`${label}: metadata must map names to text.`);
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path)); const map = new Map<string, Uint8Array>();
  for (const file of files) {
    if (!pathPattern.test(file.path) || file.path.split('/').some(part => part === '..' || part === '.') || file.path === 'SKILL.md') fail(`${label}: invalid file path ${JSON.stringify(file.path)}.`);
    if (map.has(file.path)) fail(`${label}: duplicate file ${file.path}.`); map.set(file.path, file.content);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true }); const text = (bytes: Uint8Array): boolean => { try { decoder.decode(bytes); return true; } catch { return false; } };
  const listed = files.map(file => Object.freeze({ path: file.path, bytes: file.content.byteLength, text: text(file.content) }));
  const digest = sha256(canonical({ format: 'mayura.skill.v1', name, description, license: license ?? null, allowedTools: allowed, metadata,
    instructions: input.instructions, files: files.map(file => ({ path: file.path, sha256: sha256(file.content) })) }));
  const skill: Skill = Object.freeze({ name, description, instructions: input.instructions, files: Object.freeze(listed), ...(license === undefined ? {} : { license }),
    allowedTools: Object.freeze([...allowed]), metadata: Object.freeze({ ...metadata }), digest });
  contents.set(skill, map);
  return { skill, bytes: new TextEncoder().encode(input.instructions).byteLength + files.reduce((sum, file) => sum + file.content.byteLength, 0) };
}

/**
 * Load skills from folders. Each source is either one skill folder (it has a SKILL.md) or a folder of skill folders.
 * Everything is read once, within bounds, so later reads cannot change what the digest names. Symbolic links, hidden
 * entries and node_modules are refused or skipped; a skill's name must match its folder's.
 */
export async function loadSkills(sources: string | readonly string[], options: SkillLimits = {}): Promise<SkillSet> {
  const bounds = limits(options); const skills: Skill[] = []; let total = 0;
  const folders: string[] = [];
  for (const source of typeof sources === 'string' ? [sources] : sources) {
    const directory = resolve(source); const details = await lstat(directory).catch(() => fail(`Skill source not found: ${source}`));
    if (!details.isDirectory() || details.isSymbolicLink()) fail(`Skill source must be a directory: ${source}`);
    if (await lstat(join(directory, 'SKILL.md')).then(() => true, () => false)) { folders.push(directory); continue; }
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isSymbolicLink()) fail(`Skills may not be symbolic links: ${join(source, entry.name)}`);
      if (entry.isDirectory() && await lstat(join(directory, entry.name, 'SKILL.md')).then(() => true, () => false)) folders.push(join(directory, entry.name));
    }
  }
  for (const folder of folders) {
    if (skills.length >= bounds.maxSkills) fail(`More than ${bounds.maxSkills} skills.`);
    const label = `skill folder ${basename(folder)}`; const files: { path: string; content: Uint8Array }[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8) fail(`${label} is nested too deeply.`);
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) fail(`${label} may not contain symbolic links (${relative(folder, path)}).`);
        if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const relativePath = relative(folder, path).split(sep).join('/'); if (relativePath === 'SKILL.md') continue;
        if (files.length >= bounds.maxFilesPerSkill) fail(`${label} has more than ${bounds.maxFilesPerSkill} files.`);
        const details = await lstat(path); if (details.size > bounds.maxFileBytes) fail(`${label}: ${relativePath} is larger than ${bounds.maxFileBytes} bytes.`);
        files.push({ path: relativePath, content: new Uint8Array(await readFile(path)) });
      }
    };
    const skillFile = join(folder, 'SKILL.md'); const skillDetails = await lstat(skillFile);
    if (!skillDetails.isFile() || skillDetails.isSymbolicLink()) fail(`${label}: SKILL.md must be a regular file.`);
    if (skillDetails.size > bounds.maxFileBytes) fail(`${label}: SKILL.md is larger than ${bounds.maxFileBytes} bytes.`);
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(skillFile)); } catch { return fail(`${label}: SKILL.md is not UTF-8 text.`); }
    await walk(folder, 0);
    const { fields, body } = parseSkillFile(text, `${label}/SKILL.md`);
    const { skill, bytes } = build({ name: fields['name'], description: fields['description'], instructions: body, license: fields['license'],
      allowedTools: fields['allowed-tools'], metadata: fields['metadata'], files }, label);
    if (skill.name !== basename(folder)) fail(`${label}: the name "${skill.name}" must match the folder name.`);
    total += bytes; if (total > bounds.maxTotalBytes) fail(`Skills are larger than ${bounds.maxTotalBytes} bytes together.`);
    skills.push(skill);
  }
  return createSkillSet(skills, options);
}

/** Tool input validators: strict objects of short strings, without a schema library. */
function object(fields: readonly string[]): Schema<Record<string, string>> {
  return { '~standard': { version: 1, vendor: 'mayura-skills', validate: value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected an object.' }] };
    const record = value as Record<string, unknown>; const extra = Object.keys(record).filter(key => !fields.includes(key));
    if (extra.length) return { issues: [{ message: `Unexpected field ${extra[0]}.` }] };
    for (const field of fields) if (typeof record[field] !== 'string' || !(record[field] as string).length || (record[field] as string).length > 512) return { issues: [{ message: `${field} must be a short string.` }] };
    return { value: record as Record<string, string> };
  } } } as Schema<Record<string, string>>;
}
const passthrough: Schema<unknown> = { '~standard': { version: 1, vendor: 'mayura-skills', validate: value => ({ value }) } } as Schema<unknown>;
const jsonSchema = (fields: Readonly<Record<string, string>>): JsonObject => freezeJson(jsonValue({ type: 'object', additionalProperties: false,
  required: Object.keys(fields), properties: Object.fromEntries(Object.entries(fields).map(([name, description]) => [name, { type: 'string', description }])) })) as JsonObject;

/** A skill set from skills loaded or defined elsewhere. Names must be unique. */
export function createSkillSet(skills: readonly Skill[], options: SkillLimits = {}): SkillSet {
  const bounds = limits(options);
  if (skills.length > bounds.maxSkills) fail(`More than ${bounds.maxSkills} skills.`);
  const byName = new Map<string, Skill>();
  for (const skill of skills) {
    if (!contents.has(skill)) fail('Skills must come from loadSkills or defineSkill.');
    if (byName.has(skill.name)) fail(`Two skills are named ${skill.name}.`); byName.set(skill.name, skill);
  }
  const ordered = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const digest = sha256(canonical({ format: 'mayura.skill-set.v1', skills: ordered.map(skill => skill.digest) }));
  const catalogText = ordered.length === 0 ? '' : [
    '## Skills',
    'These skills hold instructions for particular tasks. When a task matches a skill, call `skills.load` with its name and follow what it says; call `skills.read` for a file it refers to. Skills do not change what you are allowed to do.',
    ...ordered.map(skill => `- ${skill.name}: ${skill.description.replace(/\s+/gu, ' ')}`),
  ].join('\n');
  if (new TextEncoder().encode(catalogText).byteLength > bounds.maxCatalogBytes) fail(`The skill catalog is larger than ${bounds.maxCatalogBytes} bytes; use fewer skills or shorter descriptions.`);
  const skill = (name: string): Skill => byName.get(name) ?? fail(`There is no skill named ${JSON.stringify(name)}. Available: ${ordered.map(item => item.name).join(', ') || 'none'}.`) as never;
  const readText = (name: string, path: string): string => {
    const found = skill(name); const bytes = contents.get(found)!.get(path);
    if (!bytes) return fail(`The ${name} skill has no file ${JSON.stringify(path)}. Its files: ${found.files.map(file => file.path).join(', ') || 'none'}.`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail(`${path} in the ${name} skill is not a text file.`); }
  };
  const load = defineTool({ id: 'skills.load', version: digest, effects: 'none', capabilities: ['skills:read'], costMicros: 0, timeoutMs: 5_000,
    description: 'Load a skill: its full instructions and the files it bundles. Use it when a task matches a skill in the catalog.',
    input: object(['name']), output: passthrough, inputJsonSchema: jsonSchema({ name: 'The skill name from the catalog.' }),
    execute: ({ name }) => { const found = skill(name!); return { name: found.name, description: found.description, instructions: found.instructions,
      files: found.files.map(file => ({ path: file.path, bytes: file.bytes, text: file.text })) }; } });
  const read = defineTool({ id: 'skills.read', version: digest, effects: 'none', capabilities: ['skills:read'], costMicros: 0, timeoutMs: 5_000,
    description: 'Read a text file bundled with a skill, by the path skills.load listed.',
    input: object(['name', 'path']), output: passthrough, inputJsonSchema: jsonSchema({ name: 'The skill name.', path: 'The file path, as skills.load listed it.' }),
    execute: ({ name, path }) => ({ name, path, content: readText(name!, path!) }) });
  return Object.freeze({ skills: Object.freeze(ordered), digest, get: (name: string) => byName.get(name), readFile: readText,
    catalog: () => catalogText, tools: Object.freeze([load, read]) as readonly AnyTool[],
    permissions: Object.freeze(['tool:skills.load', 'tool:skills.read', 'skills:read']) });
}

/**
 * Give an agent a skill set: its catalog appended to the instructions and its two tools added. Grant
 * `skills.permissions` in the runtime too.
 */
export function withSkills<T extends { readonly instructions: string; readonly tools: readonly AnyTool[] }>(skills: SkillSet, options: T): T {
  if (skills.skills.length === 0) return options;
  if (options.tools.some(tool => tool.id === 'skills.load' || tool.id === 'skills.read')) fail('The agent already has skill tools.');
  return { ...options, instructions: `${options.instructions.trimEnd()}\n\n${skills.catalog()}`, tools: [...options.tools, ...skills.tools] };
}
