import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { defineAgent } from 'mayura';
import { anthropicMessages } from 'mayura/provider-anthropic';
import { openAICompatibleChat, openAIResponses } from 'mayura/provider-openai';
import { loadSkills } from 'mayura/skills';
import { assistantInput, assistantOutput, workspaceAssistant } from '../src/assistant.js';
import { main } from '../src/cli.js';
import { bundledSkills, loadConfig } from '../src/config.js';

// Everything runs offline, on the rule-based stand-in model, in a temporary workspace folder.

let workspace: string; let outside: string;
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'assistant-workspace-'));
  outside = await mkdtemp(join(tmpdir(), 'assistant-outside-'));
  await mkdir(join(workspace, 'src')); await mkdir(join(workspace, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# Demo\n\nA small project.\n');
  await writeFile(join(workspace, 'src', 'index.ts'), 'export const answer = 42; // TODO: explain the answer\n');
  await writeFile(join(workspace, '.env'), 'SECRET_TOKEN=do-not-show-me\n');
  await writeFile(join(workspace, 'node_modules', 'dep', 'index.js'), '// TODO inside a dependency\n');
  await writeFile(join(outside, 'private.txt'), 'outside the workspace\n');
});
after(async () => { await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

const env = (): Record<string, string> => ({ ASSISTANT_ROOT: workspace });
/** Run `assistant <argv>` with captured output and a non-terminal stdin, as a script would. */
async function ask(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''; let err = '';
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { out += String(chunk); done(); } }), { isTTY: false });
  const stderr = new Writable({ write(chunk, _encoding, done) { err += String(chunk); done(); } });
  const stdin = Object.assign(new PassThrough(), { isTTY: false }); stdin.end();
  const code = await main(argv, { env: env(), io: { stdin, stdout, stderr } });
  return { code, out, err };
}

describe('one-shot requests', () => {
  it('list, read and search the workspace', async () => {
    const listed = await ask('list', 'files');
    assert.equal(listed.code, 0); assert.match(listed.out, /README\.md \(\d+ bytes\)/u); assert.match(listed.out, /src\//u);
    assert.doesNotMatch(listed.out, /node_modules|\.env/u, 'secrets and dependencies are not listed');
    assert.match((await ask('read', 'README.md')).out, /A small project\./u);
    const found = await ask('search', 'TODO');
    assert.match(found.out, /src\/index\.ts:1/u);
    assert.doesNotMatch(found.out, /dependency/u, 'node_modules is not searched');
    const json = JSON.parse((await ask('--json', 'read', 'src/index.ts')).out) as { status: string; output: { reply: string }; spentMicros: number };
    assert.equal(json.status, 'succeeded'); assert.match(json.output.reply, /answer = 42/u); assert.equal(json.spentMicros, 0);
  });

  it('never leave the workspace or open secrets, even through a link', async () => {
    assert.match((await ask('read', '../private.txt')).out, /outside the workspace folder/u);
    const secret = await ask('read', '.env');
    assert.match(secret.out, /does not open \.env files/u); assert.doesNotMatch(secret.out, /do-not-show-me/u);
    assert.match((await ask('read', join(outside, 'private.txt'))).out, /relative to the workspace/u);
    // A link inside the workspace that points out of it is refused too (skipped where links need extra rights).
    let linked = true;
    try { await symlink(outside, join(workspace, 'escape'), 'junction'); } catch { linked = false; }
    if (linked) {
      const escaped = await ask('read', 'escape/private.txt');
      assert.match(escaped.out, /leads outside the workspace folder/u); assert.doesNotMatch(escaped.out, /outside the workspace\n/u);
      await rm(join(workspace, 'escape'), { recursive: true, force: true });
    }
  });

  it('refuse to write without a person at the terminal to confirm', async () => {
    const refused = await ask('write', 'notes.txt:', 'hello');
    assert.equal(refused.code, 1); assert.match(refused.err, /files\.write needs a person to confirm it/u);
    assert.equal(existsSync(join(workspace, 'notes.txt')), false);
  });

  it('load a skill when a task matches it', async () => {
    const answer = await ask('how', 'do', 'I', 'write', 'release', 'notes?');
    assert.equal(answer.code, 0); assert.match(answer.out, /From the release-notes skill/u); assert.match(answer.out, /\*\*Breaking\*\*/u);
  });

  it('print help, and explain a bad setting instead of a stack trace', async () => {
    assert.match((await ask('--help')).out, /assistant chat {11}chat with the assistant/u);
    let err = '';
    const code = await main(['list', 'files'], { env: { ASSISTANT_ROOT: join(workspace, 'missing') },
      io: { stderr: new Writable({ write(chunk, _encoding, done) { err += String(chunk); done(); } }) } });
    assert.equal(code, 1); assert.match(err, /ASSISTANT_ROOT must be an existing folder/u);
  });
});

/** A fake terminal for the chat: keystrokes are typed only once the expected prompt is on screen. */
function terminal() {
  const input = new PassThrough(); let raw = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { raw += String(chunk); done(); } }), { columns: 100, rows: 40 });
  const screen = (): string => raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '');
  const count = (text: string): number => screen().split(text).length - 1;
  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.\n${screen().slice(-1_500)}`); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const type = async (keys: string): Promise<void> => { for (const key of keys) { input.write(key); await new Promise(resolve => setTimeout(resolve, 2)); } };
  // The prompt symbol is ◆, or * where the terminal cannot show Unicode.
  const prompts = (): number => screen().match(/[◆*] {2}You/gu)?.length ?? 0;
  const say = async (n: number, text: string): Promise<void> => { await waitFor(() => prompts() >= n, `prompt ${n}`); await type(`${text}\r`); };
  return { input, output, screen, count, waitFor, type, say };
}

describe('chat', () => {
  it('writes a file only after the person allows it, and shows what it will write', async () => {
    const t = terminal();
    const chat = main(['chat'], { env: env(), io: { input: t.input, output: t.output } });
    await t.say(1, 'write todo.md: buy milk');
    await t.waitFor(() => t.screen().includes('Allow it?'), 'first confirmation');
    assert.match(t.screen(), /Create todo\.md \(9 bytes\)/u); assert.match(t.screen(), /buy milk/u);
    await t.type('\r'); // the default answer is No
    await t.waitFor(() => t.screen().includes('The person declined files.write.'), 'refusal');
    assert.equal(existsSync(join(workspace, 'todo.md')), false);
    await t.say(2, 'write todo.md: buy milk');
    await t.waitFor(() => t.count('Allow it?') >= 2, 'second confirmation');
    await t.type('\u001b[D\r'); // left arrow: Yes
    await t.waitFor(() => t.screen().includes('Created todo.md (9 bytes).'), 'written');
    assert.equal(await readFile(join(workspace, 'todo.md'), 'utf8'), 'buy milk\n');
    await t.say(3, '/exit');
    assert.equal(await chat, 0);
    await rm(join(workspace, 'todo.md'));
  });
});

describe('real model providers', () => {
  it('accept every tool schema and the output schema', async () => {
    // defineAgent asks each adapter to check the agent's schemas against its provider's rules; nothing is sent.
    const skills = await loadSkills(bundledSkills);
    const pricing = { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 };
    const adapters = [openAIResponses({ apiKey: 'unused', model: 'unused', maxCostMicros: 1, pricing }),
      anthropicMessages({ apiKey: 'unused', model: 'unused', maxCostMicros: 1, pricing }),
      openAICompatibleChat({ endpoint: 'https://api.example.com/v1/chat/completions', remote: { id: 'example' }, apiKey: 'unused', model: 'unused', maxCostMicros: 1, pricing })];
    for (const model of adapters) {
      const { agent } = workspaceAssistant({ root: workspace, skills, model: { provider: 'offline' }, modelOverride: model });
      assert.ok(agent.outputJsonSchema, `${model.id} receives the output schema`);
      assert.doesNotThrow(() => defineAgent({ id: 'check', version: '1', instructions: 'x', input: assistantInput, output: assistantOutput, tools: agent.tools, model }));
    }
  });
});

describe('configuration', () => {
  it('runs offline in the current folder by default, and needs a key, prices and caps for a real model', async () => {
    const config = await loadConfig({}, workspace);
    assert.equal(config.root, workspace); assert.deepEqual(config.model, { provider: 'offline' }); assert.equal(config.skillsDirectory, bundledSkills);
    await assert.rejects(loadConfig({ MAYURA_MODEL_PROVIDER: 'anthropic' }, workspace), /ANTHROPIC_API_KEY/u);
    await assert.rejects(loadConfig({ MAYURA_MODEL_PROVIDER: 'compatible', MAYURA_MODEL_API_KEY: 'k' }, workspace), /MAYURA_MODEL_ENDPOINT/u);
    const paid = await loadConfig({ MAYURA_MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'k', MAYURA_MODEL: 'm', MAYURA_MODEL_INPUT_MICROS_PER_MILLION_TOKENS: '1',
      MAYURA_MODEL_OUTPUT_MICROS_PER_MILLION_TOKENS: '1', MAYURA_MODEL_MAX_CALL_COST_MICROS: '10', MAYURA_MAX_RUN_COST_MICROS: '100' }, workspace);
    assert.equal(paid.model.provider, 'openai'); assert.equal(paid.maxRunCostMicros, 100);
  });
});
