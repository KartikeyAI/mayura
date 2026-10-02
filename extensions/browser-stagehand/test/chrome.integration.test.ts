import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowsers, type Browser, type Browsers } from 'mayura/browser';
import { localBrowsers, serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { testTool } from 'mayura/testing';
import { stagehandTools, type StagehandConstructor, type StagehandLike } from '../src/index.js';

// The real Stagehand 3 attached to a Mayura browser on the Chrome (or Edge) installed here. Its model is never called:
// extract answers from the page Stagehand would act on, so connecting, choosing the page, keeping origins and keeping
// the browser alive are all real. MAYURA_TEST_BROWSER=chrome or edge.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;
// Its own type files do not check under this repository's settings: loaded by name, and typed by shape.
const stagehandModule = '@browserbasehq/stagehand';
const { Stagehand } = channel === undefined ? { Stagehand: Object } : await import(stagehandModule) as { Stagehand: StagehandConstructor };

describe.skipIf(channel === undefined)('Stagehand on a Mayura browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser;
  const made: StagehandLike[] = [];
  /** Stagehand itself, but with extract reporting the page it was given instead of asking a model. */
  class Offline extends (Stagehand as unknown as StagehandConstructor) {
    constructor(options: Record<string, unknown>) { super(options); made.push(this); }
    override async extract(_instruction: string, _schema?: undefined, options?: { page?: { url(): string } }) { return { extraction: options?.page?.url() ?? 'no page' }; }
  }
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures();
    browsers = createBrowsers(localBrowsers({ channel: channel! }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed] });
    browser = await browsers.open();
  }, 120_000);
  afterAll(async () => { await browsers?.close(); await fixtures?.close(); });

  it('attaches to the browser and acts on its active tab', async () => {
    await browser.goto(`${fixtures.allowed}/next`);
    const extract = stagehandTools(browser, { model: 'openai/gpt-5-mini', stagehand: Offline as unknown as StagehandConstructor }).find(tool => tool.id === 'stagehand.extract')!;
    const { outcome } = await testTool(extract, { instruction: 'which page' });
    expect(outcome).toMatchObject({ status: 'succeeded', output: { extraction: `${fixtures.allowed}/next` } });
    expect(made).toHaveLength(1);
  });

  it('keeps pages Stagehand opens to the origins', async () => {
    const stagehand = made[0] as unknown as { context: { newPage(url?: string): Promise<{ goto(url: string): Promise<unknown> }> } };
    const before = fixtures.requests().length;
    const page = await stagehand.context.newPage();
    await page.goto(`${fixtures.blocked}/target?from=stagehand`).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(fixtures.requests().slice(before).filter(request => request.host === new URL(fixtures.blocked).host)).toEqual([]);
  });

  it('leaves the browser running when Stagehand closes', async () => {
    await made[0]!.close();
    expect(browser.ended).toBe(false);
    expect((await browser.goto(`${fixtures.allowed}/`)).title).toBe('Fixture home');
  });
});
