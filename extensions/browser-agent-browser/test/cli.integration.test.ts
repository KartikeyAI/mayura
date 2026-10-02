import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnyTool } from 'mayura';
import { createBrowsers, type Browser, type Browsers } from 'mayura/browser';
import { localBrowsers, serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { testTool } from 'mayura/testing';
import { agentBrowserTools } from '../src/index.js';

// The real agent-browser command line on a Mayura browser launched from the Chrome (or Edge) installed here.
// MAYURA_TEST_AGENT_BROWSER is the path to agent-browser (its binary or its script); MAYURA_TEST_BROWSER=chrome or edge.
const agentBrowser = process.env['MAYURA_TEST_AGENT_BROWSER'];
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;

describe.skipIf(agentBrowser === undefined || channel === undefined)('agent-browser on a Mayura browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser; let tools: AnyTool[];
  const run = async (id: string, input: unknown) => (await testTool(tools.find(tool => tool.id === id)!, input)).outcome as { status: string; output?: Record<string, unknown> };
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures();
    browsers = createBrowsers(localBrowsers({ channel: channel! }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed] });
    browser = await browsers.open();
    tools = agentBrowserTools(browser, { cli: [agentBrowser!], act: true, evaluate: true });
  }, 120_000);
  afterAll(async () => { await browsers?.close(); await fixtures?.close(); });

  it('reads the page as a snapshot with refs, and acts on them in the same session', async () => {
    await browser.goto(`${fixtures.allowed}/form`);
    const snapshot = await run('agent.read', { command: 'snapshot', args: ['-i'] });
    expect(snapshot).toMatchObject({ status: 'succeeded', output: { ok: true } });
    const text = String(snapshot.output!['snapshot']);
    const ref = /textbox "Query"[^\n]*\[ref=(e\d+)\]/u.exec(text)?.[1] ?? /\[ref=(e\d+)\][^\n]*textbox "Query"/u.exec(text)?.[1];
    expect(ref, text).toBeDefined();
    expect((await run('agent.act', { command: 'fill', args: [`@${ref}`, 'mayura browsers'] })).output).toMatchObject({ ok: true });
    expect((await run('agent.act', { command: 'press', args: ['Enter'] })).output).toMatchObject({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await browser.text()).text).toContain('searched for mayura browsers');
    expect((await run('agent.read', { command: 'get', args: ['title'] })).output).toMatchObject({ ok: true, title: 'Form' });
    expect((await run('agent.read', { command: 'is', args: ['visible', `@${ref}`] })).output).toMatchObject({ ok: true });
    expect((await run('agent.eval', { command: 'eval', args: ['document.title + "!"'] })).output).toMatchObject({ ok: true });
  });

  it('keeps the page to its origins whatever agent-browser runs in it', async () => {
    const before = fixtures.requests().length;
    await run('agent.eval', { command: 'eval', args: [`fetch('${fixtures.blocked}/target?via=agent-browser', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`] });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(fixtures.requests().slice(before).filter(request => request.host === new URL(fixtures.blocked).host)).toEqual([]);
  });

  it('closes its session once the browser has ended, leaving no session behind', async () => {
    await browser.release();
    // The next call notices the ended browser, refuses, and closes the session.
    expect((await run('agent.read', { command: 'snapshot' })).output).toMatchObject({ error: 'INVALID_INPUT' });
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const listed = JSON.parse(execFileSync(agentBrowser!, ['--json', 'session', 'list'], { encoding: 'utf8', windowsHide: true })) as { data?: { sessions?: string[] } };
    expect((listed.data?.sessions ?? []).filter(session => session.startsWith('mayura-'))).toEqual([]);
  });
});
