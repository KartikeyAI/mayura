// The viewer page: the stream as an image, and with interact, the person's mouse and keys sent back as input. Its
// script and style run only by the page's nonce; it reaches nothing but its own stream and input.
const script = `
const view = document.getElementById('view'); const state = document.getElementById('state');
const send = event => fetch('input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) }).catch(() => undefined);
const at = event => { const box = view.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) }; };
const mods = event => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
const button = event => ['left', 'middle', 'right'][event.button] ?? 'left';
let moved = 0;
view.addEventListener('mousedown', event => { event.preventDefault(); view.focus(); send({ type: 'mouse', action: 'down', ...at(event), button: button(event), clicks: Math.min(3, Math.max(1, event.detail)), modifiers: mods(event) }); });
view.addEventListener('mouseup', event => { event.preventDefault(); send({ type: 'mouse', action: 'up', ...at(event), button: button(event), clicks: Math.min(3, Math.max(1, event.detail)), modifiers: mods(event) }); });
view.addEventListener('mousemove', event => { const now = Date.now(); if (now - moved < 50) return; moved = now; send({ type: 'mouse', action: 'move', ...at(event), modifiers: mods(event) }); });
view.addEventListener('wheel', event => { event.preventDefault(); send({ type: 'wheel', ...at(event), dx: Math.round(event.deltaX), dy: Math.round(event.deltaY) }); }, { passive: false });
view.addEventListener('contextmenu', event => event.preventDefault());
for (const action of ['down', 'up']) view.addEventListener('key' + action, event => {
  if (event.isComposing) return;
  event.preventDefault(); send({ type: 'key', action, key: event.key, modifiers: mods(event) });
});
view.addEventListener('paste', event => { const text = event.clipboardData?.getData('text/plain'); if (text) { event.preventDefault(); send({ type: 'text', text: text.slice(0, 1000) }); } });
state.textContent = 'Live: you can use this browser. Click the page to type into it.';
`;

export function viewerPage({ interact, nonce }: { readonly interact: boolean; readonly nonce: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Browser viewer</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --edge: #d9d9d4; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ecece8; --muted: #9a9a94; --edge: #33332f; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; }
header { padding: 8px 16px; color: var(--muted); border-bottom: 1px solid var(--edge); }
main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 16px; }
img { max-width: 100%; max-height: calc(100vh - 80px); border: 1px solid var(--edge); background: #fff; outline: none; }
img:focus-visible { outline: 2px solid #3b6fd8; }
</style></head>
<body><header id="state">Live: view only.</header>
<main><img id="view" src="stream" alt="The browser's page, live"${interact ? ' tabindex="0"' : ''}></main>
${interact ? `<script nonce="${nonce}">${script}</script>` : ''}
</body></html>`;
}
