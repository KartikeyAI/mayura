import type { Browser } from './browsers.js';

/**
 * Pages the conformance cases visit, by path. Serve them on two origins of one server — one the browsers may load
 * (`allowed`), one they may not (`blocked`) — such as `serveBrowserFixtures()` from `mayura/browser/local` does.
 * `{{blocked}}` in a page stands for the blocked origin. `/redirect-out` must answer 302 to `{{blocked}}/target`.
 */
export const browserFixturePages: Readonly<Record<string, string>> = Object.freeze({
  '/': `<!doctype html><title>Fixture home</title><h1>Fixture home</h1>
<nav><a href="/next">Next page</a></nav>
<label>Choice <select id="choice"><option value="a">Apple</option><option value="b">Banana</option></select></label>
<p id="chosen">none</p><script>document.getElementById('choice').addEventListener('change', e => { document.getElementById('chosen').textContent = 'chose ' + e.target.value; });</script>`,
  '/next': '<!doctype html><title>Next</title><h1>The next page</h1><p>Arrived by link.</p>',
  '/form': `<!doctype html><title>Form</title><h1>Search</h1>
<form id="f"><label>Query <input name="q" id="q" value="old"></label><button type="submit">Search</button></form><p id="out">nothing yet</p>
<script>document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); document.getElementById('out').textContent = 'searched for ' + document.getElementById('q').value; });</script>`,
  '/dialog': `<!doctype html><title>Dialog</title><button onclick="alert('hello from the page'); document.getElementById('after').textContent = 'dismissed'">Alert me</button><p id="after">waiting</p>`,
  '/outbound': `<!doctype html><title>Outbound</title><h1>Outbound</h1><p id="fetch">pending</p><p id="worker">pending</p><p id="shared">pending</p><p id="service">pending</p>
<img src="{{blocked}}/pixel.png" alt="">
<iframe src="{{blocked}}/target" title="other origin"></iframe>
<script>
fetch('{{blocked}}/target', { mode: 'no-cors' }).then(() => { document.getElementById('fetch').textContent = 'reached'; }, () => { document.getElementById('fetch').textContent = 'blocked'; });
const worker = new Worker('/worker.js');
worker.onmessage = e => { document.getElementById('worker').textContent = e.data; };
try { const shared = new SharedWorker('/shared.js'); shared.port.onmessage = e => { document.getElementById('shared').textContent = e.data; }; }
catch { document.getElementById('shared').textContent = 'unavailable'; }
navigator.serviceWorker ? navigator.serviceWorker.register('/sw.js').then(() => { document.getElementById('service').textContent = 'registered'; }, () => { document.getElementById('service').textContent = 'refused'; })
  : (document.getElementById('service').textContent = 'unavailable');
setTimeout(() => { for (const id of ['shared', 'service']) { const item = document.getElementById(id); if (item.textContent === 'pending') item.textContent = 'held'; } }, 3000);
</script>`,
  '/worker.js': `fetch('{{blocked}}/target', { mode: 'no-cors' }).then(() => postMessage('reached'), () => postMessage('blocked'));`,
  '/shared.js': `onconnect = event => { const port = event.ports[0]; fetch('{{blocked}}/target', { mode: 'no-cors' }).then(() => port.postMessage('reached'), () => port.postMessage('blocked')); };`,
  '/sw.js': `self.addEventListener('install', event => { event.waitUntil(fetch('{{blocked}}/target', { mode: 'no-cors' }).then(() => undefined, () => undefined)); });`,
  '/popup': `<!doctype html><title>Popup</title><button onclick="window.open('/next')">Open a window</button>`,
  '/popup-out': `<!doctype html><title>Popup out</title><button onclick="window.open('{{blocked}}/target?from=popup')">Open elsewhere</button>`,
  '/target': '<!doctype html><title>Target</title><p>reached</p>',
  '/slow': '<!doctype html><title>Slow</title><p>slow page</p>',
});

export interface BrowserConformanceContext {
  /** A browser from the provider under test, allowed to load `allowed` only. */
  readonly browser: Browser;
  /** The origin serving `browserFixturePages` that the browser may load, such as `http://127.0.0.1:41234`. */
  readonly allowed: string;
  /** The same pages on an origin the browser may not load, such as `http://localhost:41234`. */
  readonly blocked: string;
  /** Every request the fixture server received: the origin's host and the path. */
  readonly requests: () => readonly { readonly host: string; readonly path: string }[];
}
export type BrowserConformanceResult = 'passed';
export interface BrowserConformanceCase { readonly name: string; run(context: BrowserConformanceContext): Promise<BrowserConformanceResult> }

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const refFor = (snapshot: string, pattern: RegExp): string => {
  const line = snapshot.split('\n').find(item => pattern.test(item));
  const ref = line && /\[ref=(e\d+)\]/u.exec(line)?.[1];
  if (!ref) throw new Error(`No element matching ${pattern} in the snapshot:\n${snapshot.slice(0, 2_000)}`);
  return ref;
};
const eventually = async (read: () => Promise<boolean>, message: string) => {
  for (let attempt = 0; attempt < 50; attempt++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
};
const code = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);
const blockedHost = (context: BrowserConformanceContext) => new URL(context.blocked).host;
const reachedBlocked = (context: BrowserConformanceContext) => context.requests().filter(request => request.host === blockedHost(context));

const cases: [string, (context: BrowserConformanceContext) => Promise<void>][] = [
  ['opens a page and reads it as an outline with refs', async ({ browser, allowed }) => {
    const page = await browser.goto(`${allowed}/`);
    check(page.loaded && page.status === 200 && page.title === 'Fixture home', `goto returned ${JSON.stringify(page)}.`);
    const snapshot = await browser.snapshot();
    check(/heading "Fixture home"/u.test(snapshot.text), 'The snapshot must show the heading.');
    refFor(snapshot.text, /link "Next page"/u);
  }],
  ['follows a link by its ref, and refuses a ref from before', async ({ browser, allowed }) => {
    await browser.goto(`${allowed}/`);
    const ref = refFor((await browser.snapshot()).text, /link "Next page"/u);
    await browser.click(ref);
    await eventually(async () => (await browser.snapshot()).title === 'Next', 'Clicking the link must open the next page.');
    check(await code(browser.click(ref)) === 'INVALID_INPUT', 'A ref from an older snapshot must be refused.');
    const back = await browser.back();
    check(back.url === `${allowed}/`, 'back must return to the first page.');
  }],
  ['fills an input, submits with Enter, and reads the result', async ({ browser, allowed }) => {
    await browser.goto(`${allowed}/form`);
    const input = refFor((await browser.snapshot()).text, /textbox "Query"/u);
    await browser.fill(input, 'mayura browsers');
    await browser.press('Enter');
    await eventually(async () => (await browser.text()).text.includes('searched for mayura browsers'), 'Submitting must show the query, replacing the old value.');
  }],
  ['chooses an option of a list', async ({ browser, allowed }) => {
    await browser.goto(`${allowed}/`);
    await browser.select(refFor((await browser.snapshot()).text, /combobox "Choice"/u), 'Banana');
    await eventually(async () => (await browser.text()).text.includes('chose b'), 'Choosing by label must select the option.');
    check(await code(browser.select(refFor((await browser.snapshot()).text, /combobox "Choice"/u), 'Cherry')) === 'INVALID_INPUT', 'A missing option must be refused.');
  }],
  ['takes a screenshot and evaluates JavaScript', async ({ browser, allowed }) => {
    await browser.goto(`${allowed}/next`);
    const shot = await browser.screenshot();
    check(shot.mediaType === 'image/png' && shot.data[0] === 0x89 && shot.data[1] === 0x50, 'A screenshot must be a PNG.');
    check((await browser.evaluate('document.title + 1')).value === 'Next1', 'evaluate must return the value.');
    check(typeof (await browser.evaluate('(() => { throw new Error("boom") })()')).error === 'string', 'evaluate must report what was thrown.');
  }],
  ['dismisses dialogs and reports them', async ({ browser, allowed }) => {
    await browser.goto(`${allowed}/dialog`);
    await browser.click(refFor((await browser.snapshot()).text, /button "Alert me"/u));
    await eventually(async () => (await browser.text()).text.includes('dismissed'), 'The page must carry on after its dialog.');
    check((await browser.snapshot()).dialogs.some(item => item.includes('hello from the page')), 'The dialog must be reported.');
  }],
  ['refuses to open another origin, directly or by redirect', async context => {
    const { browser, allowed, blocked } = context;
    check(await code(browser.goto(`${blocked}/target`)) === 'PERMISSION_DENIED', 'goto to another origin must be refused.');
    check(await code(browser.goto(`${allowed}/redirect-out`)) === 'PERMISSION_DENIED', 'A redirect to another origin must be refused.');
    check(reachedBlocked(context).length === 0, `The blocked origin was reached: ${JSON.stringify(reachedBlocked(context))}.`);
  }],
  ['blocks requests to other origins from pages, frames and every kind of worker', async context => {
    const { browser, allowed } = context;
    await browser.goto(`${allowed}/outbound`);
    // A worker whose requests cannot be checked may be held rather than run ('held'); either way, nothing gets out.
    await eventually(async () => { const text = (await browser.text()).text; return !text.includes('pending'); }, 'The page\'s fetch and workers must finish.');
    await new Promise(resolve => setTimeout(resolve, 500));
    const text = (await browser.text()).text;
    check(!text.includes('reached'), `A page or worker reached another origin: ${text}`);
    check(reachedBlocked(context).length === 0, `The blocked origin was reached: ${JSON.stringify(reachedBlocked(context))}.`);
  }],
  ['keeps windows a page opens to the origins, from their first request', async context => {
    const { browser, allowed } = context;
    await browser.goto(`${allowed}/popup-out`);
    await browser.click(refFor((await browser.snapshot()).text, /button "Open elsewhere"/u));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    check(reachedBlocked(context).length === 0, `A window the page opened reached another origin: ${JSON.stringify(reachedBlocked(context))}.`);
    for (const tab of (await browser.tabs()).filter(item => !item.active)) await browser.closeTab(tab.tab);
  }],
  ['opens, lists, switches and closes tabs, including windows a page opens', async ({ browser, allowed }) => {
    await browser.goto(`${allowed}/popup`);
    const before = (await browser.tabs()).length;
    await browser.click(refFor((await browser.snapshot()).text, /button "Open a window"/u));
    await eventually(async () => (await browser.tabs()).length === before + 1, 'A window the page opens must appear as a tab.');
    const opened = await browser.newTab(`${allowed}/next`);
    check((await browser.tabs()).find(tab => tab.active)?.tab === opened.tab, 'A new tab becomes the active one.');
    await browser.closeTab(opened.tab);
    const left = await browser.tabs();
    check(left.length === before + 1 && !left.some(tab => tab.tab === opened.tab), 'A closed tab must be gone.');
    await browser.selectTab(left[0]!.tab);
  }],
];

/**
 * Cases every browser provider must pass with `createBrowsers(provider, { origins: [allowed] })` and the fixture pages
 * served on two origins. Each settles with 'passed' or throws what failed.
 */
export const browserConformance: readonly BrowserConformanceCase[] = Object.freeze(cases.map(([name, body]) => Object.freeze({
  name, run: async (context: BrowserConformanceContext) => { await body(context); return 'passed' as const; },
})));
