// Live check of @mayurajs/cloudflare-quick-action against Cloudflare Browser Run: each action once on a public page.
// Run from the repository root, after pnpm build: node --env-file=.env.live scripts/live/cloudflare-quick-action.mjs
// (needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BROWSER_TOKEN, a token with Browser Rendering - Edit). Free plan: REST calls
// are limited to one every 10 seconds, so the script waits between them.
const root = new URL('../../', import.meta.url);
const { cloudflareQuickActions, quickActionTools } = await import(new URL('extensions/cloudflare-quick-action/dist/index.js', root).href);
const { testTool } = await import(new URL('packages/mayura/dist/testing.js', root).href);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID; const apiToken = process.env.CLOUDFLARE_BROWSER_TOKEN;
if (!accountId || !apiToken) { console.log('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_BROWSER_TOKEN is not set; nothing run.'); process.exit(2); }
const actions = cloudflareQuickActions({ accountId, apiToken });
const results = []; const pause = () => new Promise(resolve => setTimeout(resolve, 11_000));
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } await pause(); };
await check('markdown', async () => { const text = await actions.markdown({ url: 'https://example.com/' }); if (!/Example Domain/.test(text)) throw new Error(text.slice(0, 200)); });
await check('content (envelope or HTML)', async () => { const html = await actions.content({ url: 'https://example.com/' }); if (!/<h1>/i.test(html)) throw new Error(html.slice(0, 200)); });
await check('links', async () => { const links = await actions.links({ url: 'https://example.com/' }); if (!Array.isArray(links) || links.length === 0) throw new Error(JSON.stringify(links)); });
await check('scrape', async () => { const found = await actions.scrape({ url: 'https://example.com/', selectors: ['h1'] }); if (found[0]?.results[0]?.text !== 'Example Domain') throw new Error(JSON.stringify(found)); });
await check('screenshot', async () => { const image = await actions.screenshot({ url: 'https://example.com/' }); if (image[0] !== 0x89) throw new Error('not a PNG'); });
await check('allowRequestPattern accepted', async () => {
  const tools = quickActionTools(actions, { origins: ['https://example.com'] });
  const { outcome } = await testTool(tools.find(tool => tool.id === 'cloudflare.markdown'), { url: 'https://example.com/' });
  if (outcome.status !== 'succeeded') throw new Error(JSON.stringify(outcome));
});
await check('crawl', async () => {
  const id = await actions.crawl.start({ url: 'https://example.com/', limit: 1 });
  for (let attempt = 0; attempt < 30; attempt++) {
    await pause(); const status = await actions.crawl.status(id, { limit: 1 });
    if (status.status !== 'running') { if (status.status !== 'completed') throw new Error(status.status); return; }
  }
  await actions.crawl.cancel(id); throw new Error('the crawl did not finish');
});
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
