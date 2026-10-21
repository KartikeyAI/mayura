import { spawn } from 'node:child_process';
const api = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/hono-node.mjs'], { env: { ...process.env, PORT: '3001', HOST: '127.0.0.1' }, stdio: 'inherit', windowsHide: true });
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', windowsHide: true });
let closing = false; const stop = () => { if (closing) return; closing = true; api.kill(); web.kill(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop); api.once('exit', stop); web.once('exit', stop);
