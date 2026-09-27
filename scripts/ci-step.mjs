// Run one CI command and stream its output. If it fails on GitHub Actions, also publish the tail of that output as
// an error annotation: job logs require signing in, but annotations are readable by anyone who can see the run.
//   node scripts/ci-step.mjs -- <command> [args...]
import { spawn } from 'node:child_process';

const separator = process.argv.indexOf('--');
const [command, ...args] = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
if (!command) { console.error('Usage: node scripts/ci-step.mjs -- <command> [args...]'); process.exit(2); }

// `node` runs directly. On Windows, pnpm and npm are .cmd shims that only a shell resolves; CI passes fixed literals
// without spaces, so they run as one command string (an args array with shell: true is deprecated and unquoted).
const viaShell = process.platform === 'win32' && command !== 'node';
if (viaShell && args.some(arg => /[\s"&|<>^]/.test(arg))) { console.error('ci-step: shell arguments must be plain literals.'); process.exit(2); }
const child = viaShell ? spawn([command, ...args].join(' '), { stdio: ['inherit', 'pipe', 'pipe'], shell: true })
  : spawn(command === 'node' ? process.execPath : command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
let tail = '';
const keep = chunk => { tail = (tail + chunk.toString('utf8')).slice(-65_536); };
child.stdout.on('data', chunk => { process.stdout.write(chunk); keep(chunk); });
child.stderr.on('data', chunk => { process.stderr.write(chunk); keep(chunk); });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('close', (code, signal) => {
  const status = code ?? (signal ? 1 : 0);
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
    process.stdout.write(`\n::error title=${property(`${[command, ...args].join(' ')} failed (exit ${status})`)}::${data(message)}\n`);
    // Also publish the last lines on their own: the end of the output often names the cause.
    const last = lines.slice(-12).join('\n').slice(-1_500);
    if (marker >= 0 && !message.endsWith(last)) process.stdout.write(`::error title=${property('last output lines')}::${data(last)}\n`);
  }
  process.exit(status);
});
