// A stand-in for Apple's `container` command line that runs the same command lines through Docker: their flags are
// the same, but for `delete` (Docker's `rm`). It records each command line to MAYURA_FAKE_CONTAINER_LOG.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.MAYURA_FAKE_CONTAINER_LOG) appendFileSync(process.env.MAYURA_FAKE_CONTAINER_LOG, `${JSON.stringify(args)}\n`);
// Docker removes a container that is not there without complaint; Apple's `container` reports it as not found.
if (args[0] === 'delete') {
  const found = spawnSync('docker', ['container', 'inspect', args.at(-1)], { stdio: 'ignore', windowsHide: true });
  if (found.status !== 0) { process.stderr.write(`Error: notFound: "container with id ${args.at(-1)} not found"\n`); process.exit(1); }
}
const translated = args[0] === 'delete' ? ['rm', ...args.slice(1)] : args;
// Apple pulls nothing here either: keep Docker from pulling.
if (translated[0] === 'run') translated.splice(1, 0, '--pull', 'never');
const child = spawn('docker', translated, { stdio: 'inherit', windowsHide: true });
child.on('close', code => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill());
