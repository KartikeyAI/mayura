// Live check of @mayurajs/browser-browserless: the browser conformance suite's public-page parts on a real session.
// Run from the repository root, after pnpm build: node --env-file=.env.live scripts/live/browser-browserless.mjs  (needs BROWSERLESS_TOKEN)
const root = new URL('../../', import.meta.url);
const { createBrowsers } = await import(new URL('packages/mayura/dist/browser.js', root).href);
const { browserlessBrowsers } = await import(new URL('extensions/browser-browserless/dist/index.js', root).href);

const apiKey = process.env.BROWSERLESS_TOKEN;
if (!apiKey) { console.log('BROWSERLESS_TOKEN is not set; nothing run.'); process.exit(2); }
const browsers = createBrowsers(browserlessBrowsers({ token: apiKey }), { maxBrowsers: 1, maxLifetimeMs: 120_000, origins: ['https://example.com', 'https://www.iana.org'] });
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
try {
  const browser = await browsers.open({ lifetimeMs: 110_000 });
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
} finally {
  await browsers.close().catch(error => results.push(['close', `FAILED: ${error.message}`]));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
