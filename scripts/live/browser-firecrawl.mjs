// Live check of @mayurajs/browser-firecrawl: the browser conformance suite's public-page parts on a real session.
// Run from the repository root, after pnpm build: node --env-file=.env.live scripts/live/browser-firecrawl.mjs  (needs FIRECRAWL_API_KEY)
const root = new URL('../../', import.meta.url);
const { createBrowsers } = await import(new URL('packages/mayura/dist/browser.js', root).href);
const { firecrawlBrowsers, firecrawlTools } = await import(new URL('extensions/browser-firecrawl/dist/index.js', root).href);

const apiKey = process.env.FIRECRAWL_API_KEY;
if (!apiKey) { console.log('FIRECRAWL_API_KEY is not set; nothing run.'); process.exit(2); }
const browsers = createBrowsers(firecrawlBrowsers({ apiKey }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: ['https://example.com', 'https://www.iana.org'] });
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
try {
  const browser = await browsers.open({ lifetimeMs: 300_000 });
  await check('live view', async () => { if (!/^https:\/\//.test(browser.liveViewUrl ?? '')) throw new Error('no live view'); });
  await check('opens a page and snapshots it', async () => {
    const page = await browser.goto('https://example.com/');
    if (!page.loaded || page.status !== 200) throw new Error(JSON.stringify(page));
    const snapshot = await browser.snapshot();
    if (!/heading "Example Domain"/.test(snapshot.text)) throw new Error(snapshot.text.slice(0, 500));
  });
  await check('origins enforced through the provider (Fetch works)', async () => {
    const error = await browser.goto('https://www.wikipedia.org/').then(() => undefined, caught => caught);
    if (error?.code !== 'PERMISSION_DENIED') throw new Error('navigation outside the origins was not refused');
    const fetched = await browser.evaluate("fetch('https://www.wikipedia.org/', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')");
    if (fetched.value !== 'blocked') throw new Error(`page fetch: ${JSON.stringify(fetched)}`);
  });
  await check('follows a link and takes a screenshot', async () => {
    const snapshot = await browser.snapshot();
    const ref = /link "[^"]*" \[ref=(e\d+)\]/.exec(snapshot.text)?.[1];
    if (!ref) throw new Error('no link');
    await browser.click(ref);
    const shot = await browser.screenshot();
    if (shot.data[0] !== 0x89) throw new Error('not a PNG');
  });
  await browser.release();
  // The web-data tools, on public pages.
  const { testTool } = await import(new URL('packages/mayura/dist/testing.js', root).href);
  const tools = firecrawlTools({ apiKey, origins: ['https://example.com'], extract: true });
  const tool = id => tools.find(item => item.id === id);
  await check('scrape', async () => {
    const { outcome } = await testTool(tool('web.scrape'), { url: 'https://example.com/' });
    if (outcome.status !== 'succeeded' || !/Example Domain/.test(outcome.output.markdown ?? '')) throw new Error(JSON.stringify(outcome).slice(0, 500));
  });
  await check('map', async () => {
    const { outcome } = await testTool(tool('web.map'), { url: 'https://example.com/', limit: 10 });
    if (outcome.status !== 'succeeded' || !Array.isArray(outcome.output.links)) throw new Error(JSON.stringify(outcome).slice(0, 500));
  });
  await check('extract', async () => {
    const { outcome } = await testTool(tool('web.extract'), { url: 'https://example.com/', prompt: 'the page heading', schema: { type: 'object', properties: { heading: { type: 'string' } } } });
    if (outcome.status !== 'succeeded' || outcome.output.data === null) throw new Error(JSON.stringify(outcome).slice(0, 500));
  });
} finally {
  await browsers.close().catch(error => results.push(['close', `FAILED: ${error.message}`]));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
