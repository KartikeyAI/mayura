import { createBrowsers, browserTools } from 'mayura/browser';
import { browserbaseBrowsers } from '@mayurajs/browser-browserbase';

// Local Chrome is built in; Browserbase, Steel, Kernel
// and seven more host browsers for you.
const browsers = createBrowsers(browserbaseBrowsers({ apiKey }), {
  maxBrowsers: 2,
  maxLifetimeMs: 30 * 60_000,
  // Pages load only from the origins you list.
  origins: ['https://docs.example.com'],
});

const browser = await browsers.open();
console.log(browser.liveViewUrl); // a link to watch it work

// Reading is on; clicking and typing need act: true
// and browser:web:act on the run.
const tools = browserTools(browser, { name: 'web' });
