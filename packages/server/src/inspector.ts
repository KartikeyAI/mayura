/**
 * Read-only local inspector, served same-origin by the agent server when `inspector: true`. The page and script are
 * static and contain no data; every read goes through the authenticated API with a token the operator types, which
 * stays in page memory. All values are rendered as text nodes, never as markup.
 */
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mayura inspector</title><link rel="stylesheet" href="/inspector/app.css"></head>
<body><header><h1>Mayura inspector</h1><form id="auth" autocomplete="off"><label>Access token <input id="token" type="password" required></label>
<button type="submit">Connect</button><button type="button" id="forget">Forget token</button></form><p id="status" role="status">Not connected.</p></header>
<nav aria-label="Sections"><button data-view="overview">Overview</button><button data-view="workflows">Workflows</button>
<button data-view="humans">Human requests</button><button data-view="fleet">Fleet</button><button data-view="run">Run</button></nav>
<main id="view" tabindex="-1"></main><script src="/inspector/app.js"></script></body></html>
`;
const css = `:root{color-scheme:light dark;--ink:#1d1f23;--muted:#5d636f;--line:#d8dbe0;--accent:#2d5bd7;--bg:#fff;--panel:#f6f7f9}
@media (prefers-color-scheme:dark){:root{--ink:#e7e9ee;--muted:#9aa1ad;--line:#343944;--accent:#8aa8ff;--bg:#15171b;--panel:#1d2026}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,sans-serif;color:var(--ink);background:var(--bg)}
header,nav,main{padding:12px 16px}header{border-bottom:1px solid var(--line)}h1{font-size:18px;margin:0 0 8px}
form{display:flex;flex-wrap:wrap;gap:8px;align-items:center}input,select{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);cursor:pointer}
button[aria-current=page]{border-color:var(--accent);color:var(--accent)}nav{display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid var(--line)}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}pre{background:var(--panel);padding:8px;border-radius:6px;overflow:auto;max-height:420px}
.muted{color:var(--muted)}.error{color:#c0392b}code{font-family:ui-monospace,monospace}
`;
const js = `'use strict';
(() => {
  let token = '';
  const view = document.getElementById('view'); const status = document.getElementById('status');
  const el = (tag, text, attributes) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text);
    for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, value); return node; };
  const clear = () => { while (view.firstChild) view.firstChild.remove(); };
  const say = (text, error) => { status.textContent = text; status.className = error ? 'error' : ''; };
  const api = async (path) => {
    if (!token) throw new Error('Enter an access token first.');
    const response = await fetch(path, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', redirect: 'error' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((body && body.error && body.error.code) || ('HTTP ' + response.status));
    return body;
  };
  const table = (columns, rows) => { const node = el('table'); const head = el('tr'); for (const column of columns) head.append(el('th', column.label));
    node.append(head); for (const row of rows) { const line = el('tr'); for (const column of columns) { const cell = el('td'); const value = column.value(row);
      if (value instanceof Node) cell.append(value); else cell.textContent = value === undefined || value === null ? '' : String(value); line.append(cell); } node.append(line); }
    return node; };
  const json = (value) => el('pre', JSON.stringify(value, null, 2));
  const section = (title) => { const node = el('section'); node.append(el('h2', title)); view.append(node); return node; };
  const guarded = (render) => async (...args) => { clear(); try { await render(...args); view.focus(); } catch (error) { view.append(el('p', error.message, { class: 'error' })); } };

  const overview = guarded(async () => {
    const health = await api('/v1/operations/health').catch(error => ({ unavailable: error.message }));
    section('Readiness').append(json(health));
    const agents = await api('/v1/agents');
    section('Agents').append(table([{ label: 'Agent', value: row => row.id }, { label: 'Version', value: row => row.version }], agents.agents || []));
    const tools = await api('/v1/tools?limit=100').catch(() => ({ tools: [] }));
    section('Tools').append(table([{ label: 'Agent', value: row => row.agentId }, { label: 'Tool', value: row => row.id + '@' + row.version }, { label: 'Effects', value: row => row.effects }, { label: 'Capabilities', value: row => (row.capabilities || []).join(', ') }], tools.tools || []));
  });
  const workflows = guarded(async (after) => {
    const page = await api('/v1/workflow-runs?limit=50' + (after ? '&after=' + encodeURIComponent(after) : ''));
    const open = (id) => { const button = el('button', id.slice(0, 12) + '…', { title: id }); button.addEventListener('click', () => workflow(id)); return button; };
    section('Workflow runs').append(table([{ label: 'Run', value: row => open(row.runId) }, { label: 'Status', value: row => row.status },
      { label: 'Definition', value: row => row.definitionId + '@' + row.definitionVersion }, { label: 'Format', value: row => row.format }, { label: 'Revision', value: row => row.revision }], page.items || []));
    if (page.next) { const more = el('button', 'Next page'); more.addEventListener('click', () => workflows(page.next)); view.append(more); }
  });
  const workflow = guarded(async (id) => {
    const value = await api('/v1/workflow-runs/' + id);
    const node = section('Workflow ' + id);
    const steps = value.steps ? Object.entries(value.steps).map(([name, step]) => ({ name, ...step })) : (value.nodes || []);
    if (steps.length) node.append(table([{ label: 'Step', value: row => row.name || row.id }, { label: 'Status', value: row => row.status },
      { label: 'Depends on', value: row => (row.dependsOn || []).join(', ') }], steps));
    node.append(json(value));
  });
  const humans = guarded(async () => {
    const page = await api('/v1/human-requests?limit=50');
    section('Human requests').append(table([{ label: 'Request', value: row => row.id }, { label: 'Kind', value: row => row.kind },
      { label: 'Status', value: row => row.status }, { label: 'Prompt', value: row => row.prompt }], page.items || []));
  });
  const fleet = guarded(async () => { section('Fleet hold').append(json(await api('/v1/workflow-fleet'))); });
  const run = guarded(async () => {
    const node = section('Run'); const form = el('form'); const input = el('input', undefined, { 'aria-label': 'Run id', placeholder: 'run id', pattern: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', required: '' });
    const output = el('div'); form.append(input, el('button', 'Inspect', { type: 'submit' })); node.append(form, output);
    form.addEventListener('submit', async (event) => { event.preventDefault(); while (output.firstChild) output.firstChild.remove();
      try { output.append(json(await api('/v1/runs/' + input.value)));
        const response = await fetch('/v1/runs/' + input.value + '/events', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', redirect: 'error' });
        if (!response.ok || !response.body) throw new Error('Events unavailable (' + response.status + ')');
        const rows = []; const events = el('div'); output.append(el('h3', 'Events'), events);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = '';
        for (;;) { const { value, done } = await reader.read(); if (done) break; buffer += value;
          let index; while ((index = buffer.indexOf('\\n\\n')) >= 0) { const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const data = frame.split('\\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\\n');
            if (data) { try { rows.push(JSON.parse(data)); } catch { /* ignore malformed frames */ } }
            while (events.firstChild) events.firstChild.remove();
            events.append(table([{ label: '#', value: row => row.sequence }, { label: 'Type', value: row => row.type }, { label: 'Metadata', value: row => JSON.stringify(row.metadata || row) }], rows)); } }
      } catch (error) { output.append(el('p', error.message, { class: 'error' })); } });
  });
  const views = { overview, workflows: () => workflows(), humans, fleet, run };
  for (const button of document.querySelectorAll('nav button')) button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('nav button')) other.removeAttribute('aria-current'); button.setAttribute('aria-current', 'page');
    views[button.dataset.view]();
  });
  document.getElementById('auth').addEventListener('submit', async (event) => { event.preventDefault(); token = document.getElementById('token').value.trim();
    document.getElementById('token').value = ''; say('Connecting…');
    try { await api('/v1/agents'); say('Connected. The token is kept in this page only.'); overview(); } catch (error) { token = ''; say('Not connected: ' + error.message, true); } });
  document.getElementById('forget').addEventListener('click', () => { token = ''; clear(); say('Token forgotten.'); });
})();
`;
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};
const assets: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  '/inspector': ['text/html; charset=utf-8', html], '/inspector/app.js': ['text/javascript; charset=utf-8', js], '/inspector/app.css': ['text/css; charset=utf-8', css],
});

/** Static inspector assets for a GET of exactly these paths; `undefined` for everything else. */
export function inspectorAsset(method: string, pathname: string): Response | undefined {
  const asset = method === 'GET' && Object.hasOwn(assets, pathname) ? assets[pathname] : undefined;
  return asset ? new Response(asset[1], { status: 200, headers: { ...headers, 'Content-Type': asset[0] } }) : undefined;
}
