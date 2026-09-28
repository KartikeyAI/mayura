// Runs in place of worker.js, with the worker's exact process flags, to show what code that escaped the QuickJS
// interpreter could do in the worker process. Each probe reports "denied" or what it achieved.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const [outsideFile, allowedFile] = process.argv.slice(2);
const probe = work => { try { return work(); } catch (error) { return error?.code === 'ERR_ACCESS_DENIED' || error instanceof EvalError ? 'denied' : `error:${error?.code ?? error?.name}`; } };
const result = {
  readOutside: probe(() => { readFileSync(outsideFile); return 'read'; }),
  readAllowed: probe(() => { readFileSync(allowedFile); return 'read'; }),
  writeTemp: probe(() => { writeFileSync(join(tmpdir(), `mayura-escape-${process.pid}`), 'x'); return 'wrote'; }),
  spawn: probe(() => { const run = spawnSync(process.execPath, ['--version']); if (run.error) throw run.error; return 'spawned'; }),
  worker: probe(() => { new Worker('0', { eval: true }).terminate(); return 'started'; }),
  evaluate: probe(() => String(eval('1 + 1'))),
  functionConstructor: probe(() => String(new Function('return 2')())),
  environment: Object.keys(process.env),
};
process.stdout.write(JSON.stringify(result));
