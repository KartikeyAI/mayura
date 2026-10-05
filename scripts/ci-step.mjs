// Run one CI command and stream its output. If it fails on GitHub Actions, also publish the tail of that output as
// an error annotation: job logs require signing in, but annotations are readable by anyone who can see the run.
//   node scripts/ci-step.mjs [--timeout-minutes <n>] -- <command> [args...]
// With --timeout-minutes, a command still running then is stopped and reported like a failure, so a hang shows where
// it stopped; a job cancelled at its own time limit publishes nothing.
import { spawn, spawnSync } from 'node:child_process';

const separator = process.argv.indexOf('--');
const [command, ...args] = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
const options = separator >= 0 ? process.argv.slice(2, separator) : [];
if (!command) { console.error('Usage: node scripts/ci-step.mjs [--timeout-minutes <n>] -- <command> [args...]'); process.exit(2); }
let timeoutMinutes;
if (options.length > 0) {
  timeoutMinutes = Number(options[1]);
  if (options.length !== 2 || options[0] !== '--timeout-minutes' || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 360) {
    console.error('ci-step: the only option is --timeout-minutes <1 to 360>.'); process.exit(2);
  }
}

// `node` runs directly. On Windows, pnpm and npm are .cmd shims that only a shell resolves; CI passes fixed literals
// without spaces, so they run as one command string (an args array with shell: true is deprecated and unquoted).
const viaShell = process.platform === 'win32' && command !== 'node';
if (viaShell && args.some(arg => /[\s"&|<>^]/.test(arg))) { console.error('ci-step: shell arguments must be plain literals.'); process.exit(2); }
// Off Windows the command leads its own process group, so a timeout stops everything it started.
const child = viaShell ? spawn([command, ...args].join(' '), { stdio: ['inherit', 'pipe', 'pipe'], shell: true })
  : spawn(command === 'node' ? process.execPath : command, args, { stdio: ['inherit', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
let timedOut = false;
const timer = timeoutMinutes === undefined ? undefined : setTimeout(() => {
  timedOut = true;
  console.error(`ci-step: still running after ${timeoutMinutes} minutes; stopping it.`);
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}, timeoutMinutes * 60_000);
let tail = '';
const keep = chunk => { tail = (tail + chunk.toString('utf8')).slice(-65_536); };
child.stdout.on('data', chunk => { process.stdout.write(chunk); keep(chunk); });
child.stderr.on('data', chunk => { process.stderr.write(chunk); keep(chunk); });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('close', (code, signal) => {
  if (timer) clearTimeout(timer);
  const status = timedOut ? 124 : code ?? (signal ? 1 : 0);
  if (status !== 0 && process.env.GITHUB_ACTIONS === 'true') {
    // eslint-disable-next-line no-control-regex
    // GitHub truncates an annotation message at about 4 KB, so keep the end of the output (where summaries and errors
    // are) and lead with any failure section a test runner printed.
    const lines = tail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
    const marker = lines.findIndex(line => /Failed Tests|Unhandled (Errors?|Rejection)|Error:|ERR_|FAIL /.test(line));
    const budget = 3_500; const pick = []; let used = 0;
    for (const line of marker >= 0 ? lines.slice(marker) : lines.slice().reverse()) {
      if (used + line.length + 1 > budget) break; pick.push(line); used += line.length + 1;
    }
    const message = (marker >= 0 ? pick : pick.reverse()).join('\n');
    const data = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    const property = value => data(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
    const outcome = timedOut ? `timed out after ${timeoutMinutes} minutes` : `failed (exit ${status})`;
    process.stdout.write(`\n::error title=${property(`${[command, ...args].join(' ')} ${outcome}`)}::${data(message)}\n`);
    // Also publish the last lines on their own: the end of the output often names the cause.
    const last = lines.slice(-12).join('\n').slice(-1_500);
    if (marker >= 0 && !message.endsWith(last)) process.stdout.write(`::error title=${property('last output lines')}::${data(last)}\n`);
  }
  process.exit(status);
});
