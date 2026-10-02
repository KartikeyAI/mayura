import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyTool } from 'mayura';
import type { Browser } from 'mayura/browser';
import { testTool, toolGrants } from 'mayura/testing';
import { agentBrowserTools } from '../src/index.js';

const cli = [process.execPath, fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))];
function stubBrowser(extra: Partial<{ headers: Record<string, string>; isolated: boolean; ended: boolean; unjoinable: boolean }> = {}) {
  const state = { ended: extra.ended ?? false };
  const browser = { id: 'b1', provider: 'local', get ended() { return state.ended; }, goto: async () => undefined,
    ...(extra.unjoinable ? {} : { cdp: { url: 'ws://127.0.0.1:9222/devtools/browser/1', headers: extra.headers ?? {}, isolated: extra.isolated ?? false } }) } as unknown as Browser;
  return { browser, end: () => { state.ended = true; } };
}
const find = (tools: AnyTool[], id: string) => tools.find(tool => tool.id === id)!;
const run = async (tools: AnyTool[], id: string, input: unknown) => (await testTool(find(tools, id), input)).outcome as { status: string; output?: Record<string, unknown> };

let directory: string; let log: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'mayura-ab-')); log = join(directory, 'calls.log'); process.env['MAYURA_FAKE_AB_LOG'] = log; delete process.env['MAYURA_FAKE_AB_REPLY']; });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);

describe('agentBrowserTools', () => {
  it('reads by default; acting and JavaScript each need enabling and their own permission', () => {
    const { browser } = stubBrowser();
    expect(agentBrowserTools(browser, { cli }).map(tool => [tool.id, tool.capabilities, tool.effects])).toEqual([['agent.read', ['agent-browser:agent:read'], 'read']]);
    expect(agentBrowserTools(browser, { cli, name: 'ab', act: true, evaluate: true }).map(tool => [tool.id, tool.capabilities, tool.effects])).toEqual([
      ['ab.read', ['agent-browser:ab:read'], 'read'], ['ab.act', ['agent-browser:ab:act'], 'write'], ['ab.eval', ['agent-browser:ab:evaluate'], 'write']]);
    expect(() => agentBrowserTools({} as Browser)).toThrow(/browser/u);
    expect(() => agentBrowserTools(browser, { name: 'Bad Name' })).toThrow(/name/u);
    expect(() => agentBrowserTools(browser, { cli: [] })).toThrow(/cli/u);
    expect(() => agentBrowserTools(browser, { timeoutMs: 10 })).toThrow(/timeoutMs/u);
  });

  it('runs commands on the CDP endpoint of the browser, in a session of its own, without its bookkeeping', async () => {
    const { browser } = stubBrowser();
    const tools = agentBrowserTools(browser, { cli, act: true, evaluate: true });
    expect(await run(tools, 'agent.read', { command: 'snapshot', args: ['-i', '-d', '3'] })).toMatchObject({ status: 'succeeded', output: { ok: true, snapshot: '- heading "Title" [ref=e1]' } });
    expect((await run(tools, 'agent.read', { command: 'get', args: ['title'] })).output).toEqual({ ok: true, title: 'Example' });
    expect((await run(tools, 'agent.act', { command: 'fill', args: ['@e1', 'mayura'] })).output).toEqual({ ok: true, done: 'fill' });
    expect((await run(tools, 'agent.eval', { command: 'eval', args: ['document.title.length'] })).output).toEqual({ ok: true, result: 42 });
    const seen = calls();
    expect(seen[0]!.slice(0, 2)).toEqual(['--cdp', 'ws://127.0.0.1:9222/devtools/browser/1']);
    expect(seen[0]!.slice(2, 5)).toEqual(['--session', expect.stringMatching(/^mayura-[0-9a-f-]{36}$/u), '--json']);
    expect(seen.map(args => args.slice(5))).toEqual([['snapshot', '-i', '-d', '3'], ['get', 'title'], ['fill', '@e1', 'mayura'], ['eval', 'document.title.length']]);
    expect(new Set(seen.map(args => args[3])).size).toBe(1);
  });

  it('refuses commands, flags and arguments outside its list, in words the model can act on', async () => {
    const { browser } = stubBrowser();
    const tools = agentBrowserTools(browser, { cli, act: true });
    const refused: [string, unknown][] = [
      ['agent.read', { command: 'snapshot', args: ['--cdp', 'ws://evil.example'] }], ['agent.read', { command: 'snapshot', args: ['-x'] }],
      ['agent.read', { command: 'get', args: ['cookies'] }], ['agent.read', { command: 'is', args: ['visible'] }], ['agent.read', { command: 'is', args: ['hidden', '@e1'] }], ['agent.read', { command: 'snapshot', args: ['extra'] }],
      ['agent.act', { command: 'fill', args: ['@e1', '--session=other'] }], ['agent.act', { command: 'scroll', args: ['sideways'] }], ['agent.act', { command: 'click', args: [] }],
      ['agent.read', { command: 'snapshot', args: ['-d'] }],
    ];
    for (const [id, input] of refused) expect((await run(tools, id, input)).output, JSON.stringify(input)).toMatchObject({ error: 'INVALID_INPUT' });
    for (const command of ['open', 'read', 'close', 'cookies', 'auth', 'network', 'upload', 'screenshot', 'pdf', 'chat', 'plugin', 'eval']) {
      expect((await run(tools, 'agent.act', { command, args: ['x'] })).status, command).not.toBe('succeeded');
      expect((await run(tools, 'agent.read', { command, args: ['x'] })).status, command).not.toBe('succeeded');
    }
    expect(() => readFileSync(log)).toThrow();
  });

  it('reports what agent-browser could not do, and bounds what comes back', async () => {
    const { browser } = stubBrowser();
    const tools = agentBrowserTools(browser, { cli, act: true, maxResultBytes: 4_096 });
    process.env['MAYURA_FAKE_AB_REPLY'] = 'fail';
    expect((await run(tools, 'agent.act', { command: 'click', args: ['@e9'] })).output).toEqual({ ok: false, error: 'Element not found: @e9' });
    process.env['MAYURA_FAKE_AB_REPLY'] = 'big';
    const big = (await run(tools, 'agent.read', { command: 'snapshot' })).output!;
    expect(big).toMatchObject({ ok: true, truncated: true }); expect(String(big['snapshot']).length).toBe(2_048);
    process.env['MAYURA_FAKE_AB_REPLY'] = 'bigvalue';
    expect((await run(tools, 'agent.read', { command: 'get', args: ['text', '@e1'] })).output).toMatchObject({ ok: false, error: expect.stringContaining('larger') });
    process.env['MAYURA_FAKE_AB_REPLY'] = 'text';
    expect((await run(tools, 'agent.read', { command: 'snapshot' })).status).toBe('failed');
  });

  it('stops a command at its timeout, and refuses a missing command line', async () => {
    const { browser } = stubBrowser();
    process.env['MAYURA_FAKE_AB_REPLY'] = 'slow';
    const started = Date.now();
    expect((await run(agentBrowserTools(browser, { cli, timeoutMs: 1_000 }), 'agent.read', { command: 'snapshot' })).status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await run(agentBrowserTools(browser, { cli: ['mayura-missing-agent-browser'] }), 'agent.read', { command: 'snapshot' })).status).toBe('failed');
  }, 20_000);

  it('refuses browsers it cannot be kept to, and closes the session of a browser that ended', async () => {
    for (const browser of [stubBrowser({ isolated: true }).browser, stubBrowser({ headers: { 'x-session-token': 't' } }).browser, stubBrowser({ ended: true }).browser, stubBrowser({ unjoinable: true }).browser]) {
      expect((await run(agentBrowserTools(browser, { cli }), 'agent.read', { command: 'snapshot' })).output?.['ok']).not.toBe(true);
    }
    expect(() => readFileSync(log)).toThrow();
    const first = stubBrowser(); const second = stubBrowser();
    const browsers = [first.browser, second.browser]; let next = 0;
    const tools = agentBrowserTools(async () => browsers[next]!, { cli });
    await run(tools, 'agent.read', { command: 'snapshot' });
    first.end(); next = 1;
    await run(tools, 'agent.read', { command: 'snapshot' });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const seen = calls();
    const firstSession = seen[0]![3]!;
    expect(seen.find(args => args.includes('close'))).toEqual(['--session', firstSession, '--json', 'close']);
    const snapshots = seen.filter(args => args.includes('snapshot')).map(args => args[3]);
    expect(snapshots[0]).toBe(firstSession); expect(snapshots[1]).not.toBe(firstSession);
  });

  it('runs only with its permission', async () => {
    const read = find(agentBrowserTools(stubBrowser().browser, { cli }), 'agent.read');
    const { outcome } = await testTool(read, { command: 'snapshot' }, { permissions: toolGrants(read).filter(grant => !grant.startsWith('agent-browser:')) });
    expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
  });
});
