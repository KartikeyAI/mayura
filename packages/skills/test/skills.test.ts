import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, ModelAdapter, ModelRequest, ModelResponse, Schema } from '@mayura/core';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { createSkillSet, defineSkill, loadSkills, parseSkillFile, withSkills } from '../src/index.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'skills-test', validate: value => ({ value: value as JsonValue }) } };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function folder(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mayura-skills-')); roots.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
const skillFile = (name: string, description: string, body = `# ${name}\n\nFollow these steps.\n`) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

describe('skills', () => {
  it('loads a folder of skills with their files, and builds a short catalog', async () => {
    const root = await folder({
      'pdf-forms/SKILL.md': skillFile('pdf-forms', 'Fill PDF forms. Use when the user sends a form to complete.', '# PDF forms\n\nRead references/fields.md first.\n'),
      'pdf-forms/references/fields.md': 'Field names are case-sensitive.',
      'pdf-forms/assets/logo.bin': new Uint8Array([0xff, 0xfe, 0x00, 0x81]),
      'release-notes/SKILL.md': skillFile('release-notes', 'Write release notes from merged changes.'),
      'not-a-skill/readme.md': 'ignored: no SKILL.md',
      '.hidden/SKILL.md': skillFile('hidden', 'Skipped.'),
    });
    const skills = await loadSkills(root);
    expect(skills.skills.map(skill => skill.name)).toEqual(['pdf-forms', 'release-notes']);
    const pdf = skills.get('pdf-forms')!;
    expect(pdf.instructions).toContain('Read references/fields.md first.');
    expect(pdf.files).toEqual([{ path: 'assets/logo.bin', bytes: 4, text: false }, { path: 'references/fields.md', bytes: 31, text: true }]);
    expect(skills.readFile('pdf-forms', 'references/fields.md')).toBe('Field names are case-sensitive.');
    expect(() => skills.readFile('pdf-forms', 'assets/logo.bin')).toThrow(/not a text file/u);
    expect(() => skills.readFile('pdf-forms', '../secret.txt')).toThrow(/no file/u);
    const catalog = skills.catalog();
    expect(catalog).toContain('- pdf-forms: Fill PDF forms.'); expect(catalog).toContain('skills.load');
    expect(catalog).not.toContain('case-sensitive');
    // One skill folder can be loaded directly too.
    expect((await loadSkills(join(root, 'release-notes'))).skills.map(skill => skill.name)).toEqual(['release-notes']);
  });

  it('pins content: the digest changes with any file, and the tools carry it as their version', async () => {
    const files = { 'notes/SKILL.md': skillFile('notes', 'Take notes.'), 'notes/references/style.md': 'Short sentences.' };
    const first = await loadSkills(await folder(files)); const same = await loadSkills(await folder(files));
    const changed = await loadSkills(await folder({ ...files, 'notes/references/style.md': 'Long sentences.' }));
    expect(same.digest).toBe(first.digest); expect(changed.digest).not.toBe(first.digest);
    expect(first.tools.map(tool => [tool.id, tool.version, tool.effects])).toEqual([['skills.load', first.digest, 'none'], ['skills.read', first.digest, 'none']]);
    expect(first.permissions).toEqual(['tool:skills.load', 'tool:skills.read', 'skills:read']);
  });

  it('reads the SKILL.md front matter: quotes, block scalars, lists and maps', () => {
    const { fields, body } = parseSkillFile(['---', 'name: "report-writer"', 'description: >', '  Write reports', '  from data.',
      "license: 'Apache-2.0'", 'allowed-tools:', '  - read_file', '  - search', 'metadata:', '  owner: data-team', '  version: "2"', '---', 'Body text', ''].join('\r\n'));
    expect(fields).toEqual({ name: 'report-writer', description: 'Write reports from data.', license: 'Apache-2.0', 'allowed-tools': ['read_file', 'search'],
      metadata: { owner: 'data-team', version: '2' } });
    expect(body).toBe('Body text\n');
    const skill = defineSkill({ name: 'report-writer', description: 'Write reports.', instructions: 'Do it.', allowedTools: ['search'], metadata: { owner: 'x' } });
    expect(skill).toMatchObject({ allowedTools: ['search'], metadata: { owner: 'x' } });
  });

  it('refuses skills it cannot trust or name', async () => {
    await expect(loadSkills(await folder({ 'wrong/SKILL.md': skillFile('other-name', 'Mismatched.') }))).rejects.toThrow(/must match the folder name/u);
    await expect(loadSkills(await folder({ 'bad/SKILL.md': '# no front matter' }))).rejects.toThrow(/front matter/u);
    await expect(loadSkills(await folder({ 'Bad_Name/SKILL.md': skillFile('Bad_Name', 'Upper case.') }))).rejects.toThrow(/lower-case/u);
    await expect(loadSkills(await folder({ 'empty/SKILL.md': '---\nname: empty\n---\nText\n' }))).rejects.toThrow(/description/u);
    await expect(loadSkills(await folder({ 'big/SKILL.md': skillFile('big', 'Big.'), 'big/data.txt': 'x'.repeat(2_000) }), { maxFileBytes: 1_000 })).rejects.toThrow(/larger than/u);
    expect(() => defineSkill({ name: 'escape', description: 'Escapes.', instructions: 'x', files: { '../outside.md': 'no' } })).toThrow(/invalid file path/u);
    const one = defineSkill({ name: 'twin', description: 'One.', instructions: 'x' });
    expect(() => createSkillSet([one, defineSkill({ name: 'twin', description: 'Two.', instructions: 'y' })])).toThrow(/Two skills are named twin/u);
    expect(() => createSkillSet([{ ...one }])).toThrow(/must come from/u);
    expect(() => createSkillSet([defineSkill({ name: 'long', description: 'd'.repeat(1_000), instructions: 'x' })], { maxCatalogBytes: 500 })).toThrow(/catalog is larger/u);
    // Symbolic links could point outside the skill; they are refused (where the platform lets a test create one).
    const root = await folder({ 'linked/SKILL.md': skillFile('linked', 'Has a link.'), 'target.md': 'outside' });
    const made = await symlink(join(root, 'target.md'), join(root, 'linked', 'escape.md')).then(() => true, () => false);
    if (made) await expect(loadSkills(join(root, 'linked'))).rejects.toThrow(/symbolic links/u);
  });

  it('lets an agent load a skill and read its file through the runtime, granted like any other tool', async () => {
    const skills = createSkillSet([defineSkill({ name: 'refunds', description: 'Decide refunds under the policy.', instructions: 'Check references/policy.md, then decide.',
      files: { 'references/policy.md': 'Refunds up to 50 EUR are automatic.' } })]);
    const requests: ModelRequest[] = [];
    const script: ((request: ModelRequest) => ModelResponse)[] = [
      () => ({ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'skills.load', input: { name: 'refunds' } }], usage: { costMicros: 0 } }),
      () => ({ type: 'tool_calls', calls: [{ id: 'c2', toolId: 'skills.read', input: { name: 'refunds', path: 'references/policy.md' } }], usage: { costMicros: 0 } }),
      () => ({ type: 'final', output: { decision: 'automatic' }, usage: { costMicros: 0 } }),
    ];
    const model: ModelAdapter = { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
      async generate(request) { requests.push(request); return script[requests.length - 1]!(request); } };
    const agent = defineAgent(withSkills(skills, { id: 'support', version: '1', instructions: 'You handle refunds.', model, tools: [], input: any, output: any }));
    expect(agent.instructions).toContain('- refunds: Decide refunds under the policy.');
    const denied = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] } });
    try { expect((await denied.submit(agent, { input: 'refund 30 EUR' }).result()).status).not.toBe('succeeded'); } finally { await denied.close(); }
    requests.length = 0;
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', ...skills.permissions] } });
    try {
      const outcome = await runtime.submit(agent, { input: 'refund 30 EUR' }).result();
      expect(outcome).toMatchObject({ status: 'succeeded', output: { decision: 'automatic' } });
      const history = JSON.stringify(requests[2]!.messages);
      expect(history).toContain('Check references/policy.md, then decide.'); expect(history).toContain('Refunds up to 50 EUR are automatic.');
    } finally { await runtime.close(); }
  });
});
