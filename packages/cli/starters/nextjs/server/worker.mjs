import { application } from './node.mjs';
// A separate bounded worker process; runOnce is also available to a trusted scheduler. No public cron endpoint.
const app = await application(); let stopping = false; let timer; let active;
async function cycle() {
  try { await app.runOnce(); } catch { console.error('Notebook background work needs attention.'); }
  finally { if (!stopping) timer = setTimeout(() => { active = cycle(); }, 1000); }
}
async function stop() { if (stopping) return; stopping = true; clearTimeout(timer); await active; await app.close(); }
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
console.log(JSON.stringify({ event: 'worker-started' }));
active = cycle();
