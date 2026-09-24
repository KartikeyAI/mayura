import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const packageFiles = ['core', 'tools', 'runtime', 'testing', 'sdk', 'zod'];
const mayuraNames = packageFiles.slice(0, -1).map(name => `@mayura/${name}`);

function requiredDirectory(name) {
  const value = process.env[name];
  assert(value && isAbsolute(value) && existsSync(value), `${name} must name an existing absolute directory.`);
  return realpathSync(value);
}

function npmCli() {
  const configured = process.env.MAYURA_NPM_CLI;
  const candidates = [
    configured,
    resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const selected = candidates.find(candidate => isAbsolute(candidate) && existsSync(candidate));
  assert(selected, 'Set MAYURA_NPM_CLI to the absolute npm-cli.js path.');
  return realpathSync(selected);
}

async function runNode(arguments_, cwd, timeout = 60_000) {
  try {
    return await exec(process.execPath, arguments_, {
      cwd,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '',
        npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
        npm_config_update_notifier: 'false', npm_config_offline: 'true',
      },
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Platform installation check failed.\n${String(error?.stdout ?? '')}\n${String(error?.stderr ?? '')}`);
  }
}

const tarballs = requiredDirectory('MAYURA_PACKED_TARBALL_DIR');
const evidenceRoot = requiredDirectory('MAYURA_PLATFORM_EVIDENCE_DIR');
const output = await mkdtemp(join(evidenceRoot, 'platform-install-'));
const application = join(output, 'application');
const cache = join(output, 'npm-cache');
await mkdir(application);
await mkdir(cache);

const dependencies = {};
for (const name of packageFiles) {
  const path = join(tarballs, `${name}.tgz`);
  assert(existsSync(path), `Missing packed dependency: ${basename(path)}`);
  dependencies[name === 'zod' ? 'zod' : `@mayura/${name}`] = `file:${path}`;
}
await writeFile(join(application, 'package.json'), `${JSON.stringify({
  name: 'mayura-platform-install-check', version: '1.0.0', private: true, type: 'module', dependencies,
}, null, 2)}\n`);
await runNode([npmCli(), 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], application);

const tree = JSON.parse((await runNode([npmCli(), 'ls', '--all', '--json', '--offline', '--cache', cache], application)).stdout);
const installed = new Set();
const visit = node => {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    installed.add(name);
    visit(child);
  }
};
visit(tree);
assert.deepEqual([...installed].sort(), [...Object.keys(dependencies)].sort(), 'Base installation gained an undeclared transitive dependency.');

for (const name of mayuraNames) {
  const manifest = JSON.parse(await readFile(join(application, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
  assert(!manifest.scripts && !manifest.bin && !manifest.optionalDependencies, `${name} gained executable installation behavior.`);
}

await writeFile(join(application, 'check.mjs'), `
import assert from 'node:assert/strict';
import { createRuntime, defineAgent, defineTool } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { z } from 'zod';
let calls = 0;
const add = defineTool({ id: 'math.add', version: '1', description: 'Add numbers.',
  input: z.object({ left: z.number(), right: z.number() }), output: z.object({ sum: z.number() }),
  effects: 'none', capabilities: [], execute: ({ left, right }) => { calls++; return { sum: left + right }; } });
const agent = defineAgent({ id: 'platform-check', version: '1', instructions: 'Use the tool.', tools: [add],
  input: z.string(), output: z.object({ answer: z.number() }), model: scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'one', toolId: 'math.add', input: { left: 2, right: 3 } }], usage: { costMicros: 0 } },
    { type: 'final', output: { answer: 5 }, usage: { costMicros: 0 } },
  ]) });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:math.add'] } });
try { assert.deepEqual(await runtime.submit(agent, { input: '2 + 3' }).result(), { status: 'succeeded', output: { answer: 5 } }); }
finally { await runtime.close(); }
assert.equal(calls, 1);
console.log(JSON.stringify({ status: 'passed' }));
`);
const execution = JSON.parse((await runNode([join(application, 'check.mjs')], application)).stdout);
assert.equal(execution.status, 'passed');

let operatingSystem = `${platform()} ${release()}`;
if (platform() === 'linux' && existsSync('/etc/os-release')) {
  const values = Object.fromEntries((await readFile('/etc/os-release', 'utf8')).split(/\r?\n/).filter(Boolean).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, '')];
  }));
  operatingSystem = values.PRETTY_NAME ?? operatingSystem;
}
const npmVersion = (await runNode([npmCli(), '--version'], application)).stdout.trim();
const report = {
  status: 'passed', node: process.version, npm: npmVersion, platform: platform(), architecture: arch(), operatingSystem,
  packages: [...installed].sort(), checks: ['clean-offline-packed-install', 'ignore-scripts', 'exact-base-dependency-closure',
    'no-native-server-sandbox-dependency', 'credential-free-agent-execution'],
};
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, output }));
