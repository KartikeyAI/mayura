// Live check of @mayurajs/browser-stagehand: the real Stagehand 3 with a real model on a Mayura browser (local Chrome),
// reading and acting on the conformance fixture pages. Run from the repository root, after pnpm build:
//   node --env-file=.env.live scripts/live/browser-stagehand.mjs
// Model: STAGEHAND_MODEL (default deepseek/deepseek-chat) with MAYURA_LIVE_COMPATIBLE_DEEPSEEK_KEY.
const root = new URL('../../', import.meta.url);
const { createBrowsers } = await import(new URL('packages/mayura/dist/browser.js', root).href);
const { localBrowsers, serveBrowserFixtures } = await import(new URL('packages/mayura/dist/browser__local.js', root).href);
const { testTool } = await import(new URL('packages/mayura/dist/testing.js', root).href);
const { stagehandTools } = await import(new URL('extensions/browser-stagehand/dist/index.js', root).href);
const apiKey = process.env.MAYURA_LIVE_COMPATIBLE_DEEPSEEK_KEY;
if (!apiKey) { console.log('MAYURA_LIVE_COMPATIBLE_DEEPSEEK_KEY is not set; nothing run.'); process.exit(2); }
const modelName = process.env.STAGEHAND_MODEL ?? 'deepseek/deepseek-chat';
const fixtures = await serveBrowserFixtures();
const browsers = createBrowsers(localBrowsers({ channel: 'chrome' }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed] });
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
try {
  const browser = await browsers.open();
  const tools = stagehandTools(browser, { model: { modelName, apiKey }, act: true });
  const tool = id => tools.find(item => item.id === id);
  await browser.goto(`${fixtures.allowed}/form`);
  await check('extract', async () => {
    const { outcome } = await testTool(tool('stagehand.extract'), { instruction: 'the text of the main heading' });
    if (outcome.status !== 'succeeded' || !/search/i.test(String(outcome.output.extraction))) throw new Error(JSON.stringify(outcome).slice(0, 400));
  });
  await check('observe', async () => {
    const { outcome } = await testTool(tool('stagehand.observe'), { instruction: 'the query input' });
    if (outcome.status !== 'succeeded' || outcome.output.actions.length === 0) throw new Error(JSON.stringify(outcome).slice(0, 400));
  });
  await check('act', async () => {
    const { outcome } = await testTool(tool('stagehand.act'), { instruction: 'type "mayura" into the Query input' });
    if (outcome.status !== 'succeeded' || outcome.output.success !== true) throw new Error(JSON.stringify(outcome).slice(0, 400));
    const text = (await browser.evaluate("document.getElementById('q').value")).value;
    if (!String(text).includes('mayura')) throw new Error(`the input holds ${JSON.stringify(text)}`);
  });
} finally {
  await browsers.close().catch(error => results.push(['close', `FAILED: ${error.message}`]));
  await fixtures.close();
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
