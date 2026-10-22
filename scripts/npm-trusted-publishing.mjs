// Configure package trust only; this command never builds, publishes or revokes anything.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { extensions } from './extensions.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const selected = [];
let from;
let cli = resolve('.artifacts/tools/npm-trust/node_modules/npm/bin/npm-cli.js');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') continue;
  if (args[i] === '--npm-cli' && args[i + 1]) cli = resolve(args[++i]);
  else if (args[i] === '--package' && args[i + 1]) selected.push(args[++i]);
  else if (args[i] === '--from' && args[i + 1]) from = args[++i];
  else throw new Error(`Unknown or incomplete option: ${args[i]}`);
}
const names = ['mayura', ...extensions().map((extension) => extension.manifest.name)];
for (const name of selected) {
  if (!names.includes(name)) throw new Error(`Not a workspace release package: ${name}`);
}
if (from && (!names.includes(from) || selected.length)) throw new Error('--from requires a release package and cannot be combined with --package.');
const packages = selected.length ? [...new Set(selected)] : names.slice(from ? names.indexOf(from) : 0);
const registry = 'https://registry.npmjs.org/';

/** Use npm's own login and browser verification; never inspect or persist credentials. */
function npm(command, interactive = false) {
  const result = spawnSync(process.execPath, [cli, ...command, '--registry=' + registry,
    '--fetch-retries=0', '--fetch-timeout=20000'], {
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    timeout: interactive ? 300_000 : 30_000,
  });
  if (result.error || result.status !== 0) {
    // npm errors can contain verification URLs. Keep captured errors out of reports.
    throw new Error('npm trust failed. Verify npm login and package access; run npm trust list ' +
      'mayura interactively to complete browser verification, then retry.');
  }
  return result.stdout?.trim() ?? '';
}

if (!existsSync(cli)) throw new Error('Install npm >=11.15 in .artifacts/tools/npm-trust or pass --npm-cli <npm-cli.js>.');
const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
const [major, minor] = (version.stdout ?? '').trim().split('.').map(Number);
if (version.status !== 0 || !(major > 11 || (major === 11 && minor >= 15))) {
  throw new Error('npm trust requires npm >=11.15.');
}

const totals = { configured: 0, planned: 0, created: 0, needsFirstPublish: 0, failed: 0 };
for (const name of packages) {
  try {
    const response = await fetch(registry + encodeURIComponent(name) + '/latest', {
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) {
      totals.needsFirstPublish++;
      console.log(`${name}: not found publicly; first publication required before trust setup`);
      continue;
    }
    if (!response.ok) throw new Error(`Registry lookup failed (${response.status}).`);
    const output = npm(['trust', 'list', name, '--json']);
    // npm emits one pretty-printed JSON object per configuration, separated by blank lines.
    const configs = output ? output.split(/\r?\n\s*\r?\n/).flatMap((block) => JSON.parse(block)) : [];
    const matches = (config) => config.type === 'github' && config.repository === 'KartikeyAI/mayura' &&
      config.file === 'release.yml' && config.environment === 'release' &&
      config.permissions?.includes('createPackage');
    if (configs.some(matches)) {
      totals.configured++;
      console.log(`${name}: configured`);
    } else if (configs.length) {
      throw new Error('Existing different trust configuration requires review; it was preserved.');
    } else if (!apply) {
      totals.planned++;
      console.log(`${name}: would configure KartikeyAI/mayura / release.yml / release`);
    } else {
      npm(['trust', 'github', name, '--repository', 'KartikeyAI/mayura', '--file', 'release.yml',
        '--environment', 'release', '--allow-publish', '--yes'], true);
      const verified = npm(['trust', 'list', name, '--json']);
      const configsAfter = verified ? verified.split(/\r?\n\s*\r?\n/).flatMap((block) => JSON.parse(block)) : [];
      if (!configsAfter.some(matches)) throw new Error('Created publisher could not be verified.');
      totals.created++;
      console.log(`${name}: created and verified`);
    }
  } catch (error) {
    totals.failed++;
    console.error(`${name}: ${error.message}`);
    // Stop on errors rather than issuing dozens of requests with expired verification.
    break;
  } finally {
    await new Promise((done) => setTimeout(done, 2000));
  }
}
console.log(JSON.stringify(totals));
if (totals.failed || totals.needsFirstPublish) process.exitCode = 1;
