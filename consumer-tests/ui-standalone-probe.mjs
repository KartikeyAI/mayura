import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Load the test harness before restricting subsequent module lookup to the packed app.
const { JSDOM } = await import(process.argv[2]);
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://ui.example.test/' });
await import('./module-isolation.mjs');

await assert.rejects(import('mayura'), { code: 'ERR_MODULE_NOT_FOUND' });
const css = await readFile(new URL(import.meta.resolve('@mayurajs/ui/styles.css')), 'utf8');
assert.match(css, /:where\(\.mayura-ui\)[^{}]*\.rich-composer\b/u, 'The published stylesheet must scope component styles.');

const { act, createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { App, prompt, reply, requests } = await import('./build/app.js');
const html = renderToString(createElement(App));
assert.match(html, /Plain React chat/u);
assert.match(html, /class="mayura-ui"/u);
assert.equal(requests.length, 0, 'Mounting the app must not send a run.');

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = document.getElementById('root');
root.innerHTML = html;
const style = document.createElement('style');
style.textContent = css; document.head.append(style);
const { hydrateRoot } = await import('react-dom/client');
const hydrationErrors = [];
let app;
try {
  await act(async () => { app = hydrateRoot(root, createElement(App), { onRecoverableError: error => hydrationErrors.push(error) }); });
  assert(root.querySelector('textarea'), 'The installed composer must render.');
  assert.equal(requests.length, 0, 'Hydrating the app must not send a run.');
  const send = [...root.querySelectorAll('button')].find(button => button.textContent === 'Send sample message');
  assert(send, 'The app must expose its send control.');
  await act(async () => { send.click(); });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.at(-1)?.content, prompt);
  assert.equal(root.querySelector('output[aria-label="Run status"]')?.textContent, 'complete');
  assert([...root.querySelectorAll('p')].some(message => message.textContent === reply), 'Both response deltas must render in the app.');
  assert.deepEqual(hydrationErrors, []);
} finally {
  if (app) await act(async () => { app.unmount(); });
  dom.window.close();
}
console.log(JSON.stringify({ mayuraInstalled: false, strictTypes: true, hydrated: true, streamed: true }));
