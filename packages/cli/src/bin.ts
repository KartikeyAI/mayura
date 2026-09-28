#!/usr/bin/env node
import { dirname, join, relative, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, readFile } from 'node:fs/promises';
import { jsonValue, MayuraError, publicError, type JsonValue } from '@mayura/core';
import { loadApplication, migrateApplication, runWorkerApplication, serveApplication, type MayuraLifecycleEvent } from './application.js';
import { applyProjectPlan, approveWorkflow, cancelRun, cancelWorkflow, inspectHumanRequest, inspectHumanRequests, inspectRun, inspectServerHealth,
  inspectServerTools, inspectWorkflow, inspectWorkflows, holdWorkflowFleet, inspectWorkflowFleet, pauseWorkflow, planProject, planStarter, readProject, releaseWorkflowFleet, respondHumanRequest, resumeWorkflow, sweepWorkflowFleet, signalWorkflow, starters, templates, waitForRun, STARTER_NAMES, TEMPLATE_NAMES, type StarterName, type TemplateName } from './index.js';
import { colourEnabled, help, paint, render, renderError, renderLifecycle } from './output.js';

// Readable output for a person at a terminal; the exact JSON documents otherwise (piped, redirected, or --json).
const rawArguments = process.argv.slice(2);
const json = rawArguments.includes('--json');
const human = !json && process.stdout.isTTY === true;
const out = paint(human && colourEnabled(process.stdout));
const err = paint(!json && colourEnabled(process.stderr));
const shownPath = (path: string): string => { const inner = relative(process.cwd(), path); return !inner ? '.' : inner.startsWith('..') ? path : `./${inner.replaceAll('\\', '/')}`; };

/** This CLI's version, from its own package.json (the workspace package, or lib/cli inside the published package). */
const cliVersion = (): string => (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** A usage problem the CLI itself found; its fixed message is safe and useful to show. */
const usage = (message: string): MayuraError => new MayuraError('INVALID_INPUT', message);

/** Resolve an ESM package's import entry the way Node would from the application module's directory. */
function installedEntry(application: string, name: string, subpath = '.'): string {
  for (let directory = dirname(application); ; directory = dirname(directory)) {
    const manifestPath = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { exports?: Record<string, { import?: string } | string> };
      const exported = manifest.exports?.[subpath]; const entry = typeof exported === 'string' ? exported : exported?.import; if (typeof entry !== 'string') break;
      return join(dirname(manifestPath), entry);
    }
    if (dirname(directory) === directory) break;
  }
  throw usage(`worker --probe-port requires ${name} to be installed with the application.`);
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name); if (index < 0) return undefined;
  const value = arguments_[index + 1]; if (value === undefined || value.startsWith('--')) throw usage(`Missing ${name}.`); return value;
}

function assertArguments(arguments_: readonly string[], valued: readonly string[], flags: readonly string[] = []): void {
  const seen = new Set<string>();
  for (let index = 1; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (seen.has(argument) || (!valued.includes(argument) && !flags.includes(argument))) throw usage('Unknown or repeated CLI argument.');
    seen.add(argument);
    if (valued.includes(argument)) {
      const value = arguments_[++index]; if (value === undefined || value.startsWith('--')) throw usage('CLI option value is missing.');
    }
  }
}

async function stdinToken(): Promise<string> {
  if (process.stdin.isTTY) throw usage('Operational credentials must be piped through stdin.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); size += bytes.byteLength;
    if (size > 8_194) throw usage('Operational credential input is too large.'); chunks.push(bytes);
  }
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw usage('Operational credential input is invalid.'); }
  value = value.replace(/\r?\n$/u, '');
  if (!/^[\x21-\x7e]{1,8192}$/u.test(value)) throw usage('Operational credential input is invalid.');
  return value;
}

async function jsonFile(path: string, label: string, maximum: number): Promise<JsonValue> {
  const absolute = resolve(path); const details = await lstat(absolute);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.size > maximum) throw usage(`${label} file must be a bounded regular JSON file.`);
  try { return jsonValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(absolute))), { maxBytes: maximum }); }
  catch { throw usage(`${label} file must contain bounded valid UTF-8 JSON.`); }
}

async function responseFile(path: string): Promise<JsonValue> { return jsonFile(path, 'Human response', 1_048_576); }

async function signalFile(path: string): Promise<JsonValue> {
  const value = await jsonFile(path, 'Workflow signal', 4_096);
  try { return jsonValue(value, { maxBytes: 4_096, maxDepth: 16, maxNodes: 1_024 }); }
  catch { throw usage('Workflow signal file must contain at most 4096 bytes of bounded JSON.'); }
}

async function main(arguments_: readonly string[]): Promise<unknown> {
  const command = arguments_[0];
  // No command: show what the commands are, in a terminal or not (a script that forgot one learns the same).
  if (command === undefined) return { status: 'help' };
  if (command === '--version' || command === '-v' || command === 'version') { assertArguments(arguments_, []); return { status: 'succeeded', version: cliVersion() }; }
  // Help wins anywhere on the line, so `mayura init --help` shows how to use init instead of an argument error.
  if (command === 'help' || arguments_.includes('--help') || arguments_.includes('-h')) return { status: 'help' };
  // With no options, a person at a terminal chooses interactively; scripts keep the explicit flags.
  if (command === 'init' && arguments_.length === 1 && human && process.stdin.isTTY === true) {
    const { initWizard } = await import('./interactive.js');
    const result = await initWizard(out); if (result.status === 'cancelled') process.exitCode = 1;
    return { ...result, rendered: true };
  }
  if (command === 'templates') { assertArguments(arguments_, []); return { status: 'succeeded', templates: templates() }; }
  if (command === 'starters') { assertArguments(arguments_, []); return { status: 'succeeded', starters: starters() }; }
  if (command === 'init') {
    assertArguments(arguments_, ['--template', '--starter', '--directory', '--confirm'], ['--apply']);
    const template = option(arguments_, '--template'); const starter = option(arguments_, '--starter'); const directory = option(arguments_, '--directory');
    if ((template === undefined) === (starter === undefined) || !directory) throw usage('init requires exactly one of --template or --starter, and --directory.');
    if (template !== undefined && !TEMPLATE_NAMES.includes(template as TemplateName)) throw usage('Unknown template; run mayura templates.');
    if (starter !== undefined && !STARTER_NAMES.includes(starter as StarterName)) throw usage('Unknown starter; run mayura starters.');
    const plan = starter !== undefined ? await planStarter(starter as StarterName, resolve(directory)) : await planProject(template as TemplateName, resolve(directory));
    if (!arguments_.includes('--apply') && arguments_.includes('--confirm')) throw usage('--confirm requires --apply.');
    if (arguments_.includes('--apply')) {
      const confirmation = option(arguments_, '--confirm');
      await applyProjectPlan(plan, confirmation === undefined ? {} : { confirmation });
    }
    return { status: arguments_.includes('--apply') ? 'succeeded' : 'planned', plan };
  }
  if (command === 'validate' || command === 'inspect') {
    assertArguments(arguments_, ['--file']);
    const file = option(arguments_, '--file'); if (!file) throw usage(`${command} requires --file.`);
    const project = await readProject(resolve(file));
    return command === 'validate' ? { status: 'succeeded', project: project.name, template: project.template }
      : { status: 'succeeded', project };
  }
  if (command === 'server-health' || command === 'server-tools') {
    assertArguments(arguments_, command === 'server-tools' ? ['--url', '--after', '--limit'] : ['--url'], ['--token-stdin']);
    const baseUrl = option(arguments_, '--url');
    if (!baseUrl || !arguments_.includes('--token-stdin')) throw usage(`${command} requires --url and --token-stdin.`);
    const credential = await stdinToken(); const settings = { baseUrl, token: () => credential };
    if (command === 'server-health') return { status: 'succeeded', health: await inspectServerHealth(settings) };
    const after = option(arguments_, '--after'); const limit = option(arguments_, '--limit');
    return { status: 'succeeded', page: await inspectServerTools(settings, {
      ...(after === undefined ? {} : { after: Number(after) }), ...(limit === undefined ? {} : { limit: Number(limit) }),
    }) };
  }
  if (command === 'human-list' || command === 'human-get' || command === 'human-respond') {
    const valued = command === 'human-list' ? ['--url', '--after', '--limit'] : command === 'human-get' ? ['--url', '--id']
      : ['--url', '--id', '--digest', '--command-id', '--response-file'];
    assertArguments(arguments_, valued, ['--token-stdin']); const baseUrl = option(arguments_, '--url');
    if (!baseUrl || !arguments_.includes('--token-stdin')) throw usage(`${command} requires --url and --token-stdin.`);
    const credential = await stdinToken(); const settings = { baseUrl, token: () => credential };
    if (command === 'human-list') {
      const after = option(arguments_, '--after'); const limit = option(arguments_, '--limit');
      return { status: 'succeeded', page: await inspectHumanRequests(settings, { ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit: Number(limit) }) }) };
    }
    const id = option(arguments_, '--id'); if (!id) throw usage(`${command} requires --id.`);
    if (command === 'human-get') return { status: 'succeeded', request: await inspectHumanRequest(settings, id) };
    const requestDigest = option(arguments_, '--digest'); const commandId = option(arguments_, '--command-id'); const file = option(arguments_, '--response-file');
    if (!requestDigest || !commandId || !file) throw usage('human-respond requires --digest, --command-id and --response-file.');
    return { status: 'succeeded', request: await respondHumanRequest(settings, { id, requestDigest, commandId, value: await responseFile(file) }) };
  }
  if (command === 'run-get' || command === 'run-wait' || command === 'run-cancel') {
    assertArguments(arguments_, command === 'run-wait' ? ['--url', '--id', '--poll-ms', '--wait-ms'] : ['--url', '--id'], ['--token-stdin']);
    const baseUrl = option(arguments_, '--url'); const id = option(arguments_, '--id');
    if (!baseUrl || !id || !arguments_.includes('--token-stdin')) throw usage(`${command} requires --url, --id and --token-stdin.`);
    const credential = await stdinToken(); const settings = { baseUrl, token: () => credential };
    if (command === 'run-get') return { status: 'succeeded', run: await inspectRun(settings, id) };
    if (command === 'run-cancel') { await cancelRun(settings, id); return { status: 'succeeded', cancellationRequested: true, id }; }
    const poll = option(arguments_, '--poll-ms'); const wait = option(arguments_, '--wait-ms');
    return { status: 'succeeded', run: await waitForRun(settings, id, { ...(poll === undefined ? {} : { pollIntervalMs: Number(poll) }), ...(wait === undefined ? {} : { maxWaitMs: Number(wait) }) }) };
  }
  if (command === 'dev') {
    assertArguments(arguments_, ['--app', '--entry'], ['--no-watch']);
    const app = option(arguments_, '--app'); const entry = option(arguments_, '--entry');
    // First Ctrl+C: stop watching and let the running project stop. A second one during shutdown forces exit.
    const controller = new AbortController(); let signals = 0;
    const stop = (): void => { signals += 1; if (signals > 1) process.exit(1); controller.abort(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const { runDev } = await import('./dev.js');
    try {
      return await runDev({ directory: process.cwd(), bin: fileURLToPath(import.meta.url), watch: !arguments_.includes('--no-watch'), signal: controller.signal,
        p: out, print: line => { console.log(line); }, ...(app === undefined ? {} : { app }), ...(entry === undefined ? {} : { entry }) });
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  if (command === 'migrate') {
    assertArguments(arguments_, ['--app']); const path = option(arguments_, '--app');
    if (!path) throw usage('migrate requires --app <module.mjs>.');
    return migrateApplication(await loadApplication(path));
  }
  if (command === 'serve' || command === 'worker') {
    assertArguments(arguments_, command === 'serve' ? ['--app'] : ['--app', '--probe-host', '--probe-port', '--drain-timeout-ms']);
    const path = option(arguments_, '--app'); if (!path) throw usage(`${command} requires --app <module.mjs>.`);
    const probePort = option(arguments_, '--probe-port'); const drain = option(arguments_, '--drain-timeout-ms');
    const application = await loadApplication(path);
    // Probes are an explicit opt-in served by the application's own @mayura/server-node; the CLI stays network-free.
    let listenProbe: Parameters<typeof runWorkerApplication>[0]['listenProbe'];
    if (command === 'worker' && probePort !== undefined) {
      // An installed application has `mayura`; an application inside the Mayura workspace has the internal package.
      let entry: string; try { entry = installedEntry(resolve(path), 'mayura', './server-node'); } catch {
        try { entry = installedEntry(resolve(path), '@mayura/server-node'); } catch { throw usage('worker --probe-port requires mayura to be installed with the application.'); }
      }
      listenProbe = (await import(pathToFileURL(entry).href) as { listenProbe: typeof listenProbe }).listenProbe;
    }
    // First signal: graceful close or drain. A second signal during shutdown forces exit.
    const controller = new AbortController(); let signals = 0;
    const stop = (): void => { signals += 1; if (signals > 1) process.exit(1); controller.abort(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const log = (event: MayuraLifecycleEvent): void => { console.log(human ? renderLifecycle(event, out) : JSON.stringify(event)); };
    try {
      if (command === 'serve') return await serveApplication({ application, signal: controller.signal, log });
      return await runWorkerApplication({ application, signal: controller.signal, log,
        ...(probePort === undefined ? {} : { probe: { hostname: option(arguments_, '--probe-host') ?? '127.0.0.1', port: Number(probePort) } }),
        ...(drain === undefined ? {} : { drainTimeoutMs: Number(drain) }), ...(listenProbe === undefined ? {} : { listenProbe }) });
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  if (command === 'fleet-get' || command === 'fleet-hold' || command === 'fleet-release' || command === 'fleet-sweep') {
    assertArguments(arguments_, command === 'fleet-sweep' ? ['--url', '--phase', '--limit', '--max-pages', '--cursor-file'] : ['--url'], ['--token-stdin']);
    const baseUrl = option(arguments_, '--url');
    if (!baseUrl || !arguments_.includes('--token-stdin')) throw usage(`${command} requires --url and --token-stdin.`);
    const phase = option(arguments_, '--phase'); const cursorFile = option(arguments_, '--cursor-file');
    const limit = Number(option(arguments_, '--limit') ?? 32); const maxPages = Number(option(arguments_, '--max-pages') ?? 32);
    if (command === 'fleet-sweep' && (phase !== 'pause' && phase !== 'resume' || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 256))
      throw usage('fleet-sweep requires --phase pause|resume and --max-pages between 1 and 256.');
    // Read the continuation cursor before consuming the credential so a bad file never reaches the network.
    const cursor = cursorFile === undefined ? null : await jsonFile(cursorFile, 'Fleet sweep cursor', 4_096);
    if (cursor !== null && (typeof cursor !== 'object' || Array.isArray(cursor))) throw usage('Fleet sweep cursor file must contain a JSON object.');
    const credential = await stdinToken(); const settings = { baseUrl, token: () => credential };
    if (command === 'fleet-get') return { status: 'succeeded', fleet: await inspectWorkflowFleet(settings) };
    if (command === 'fleet-hold') return { status: 'succeeded', fleet: await holdWorkflowFleet(settings) };
    if (command === 'fleet-release') return { status: 'succeeded', fleet: await releaseWorkflowFleet(settings) };
    // Bounded continuation: each page is one request; an unfinished sweep prints its cursor instead of looping further.
    const outcomes: unknown[] = []; let next = cursor as Parameters<typeof sweepWorkflowFleet>[1]['cursor']; let pages = 0;
    do { const page = await sweepWorkflowFleet(settings, { phase: phase as 'pause' | 'resume', cursor: next, limit });
      outcomes.push(...page.outcomes); next = page.nextCursor; pages += 1; } while (next && pages < maxPages);
    return { status: next ? 'incomplete' : 'succeeded', phase, pages, outcomes, nextCursor: next };
  }
  if (command === 'workflow-list' || command === 'workflow-get' || command === 'workflow-cancel' || command === 'workflow-approve' || command === 'workflow-signal' || command === 'workflow-resume' || command === 'workflow-pause') {
    const valued = command === 'workflow-list' ? ['--url', '--after', '--limit'] : command === 'workflow-get' ? ['--url', '--id'] : command === 'workflow-cancel'
      ? ['--url', '--id', '--revision', '--command-id'] : command === 'workflow-resume' || command === 'workflow-pause'
        ? ['--url', '--id', '--revision', '--command-id'] : command === 'workflow-approve'
        ? ['--url', '--id', '--revision', '--command-id', '--node', '--digest', '--child-id']
        : ['--url', '--id', '--revision', '--command-id', '--signal-id', '--signal-name', '--value-file'];
    assertArguments(arguments_, valued, command === 'workflow-list' ? ['--token-stdin', '--settled'] : ['--token-stdin']); const baseUrl = option(arguments_, '--url'); const id = option(arguments_, '--id');
    if (!baseUrl || !arguments_.includes('--token-stdin') || (command !== 'workflow-list' && !id)) throw usage(`${command} requires --url${command === 'workflow-list' ? '' : ', --id'} and --token-stdin.`);
    const credential = await stdinToken(); const settings = { baseUrl, token: () => credential };
    if (command === 'workflow-list') { const after = option(arguments_, '--after'); const limit = option(arguments_, '--limit');
      return { status: 'succeeded', page: await inspectWorkflows(settings, { ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(arguments_.includes('--settled') ? { settled: true } : {}) }) }; }
    if (command === 'workflow-get') return { status: 'succeeded', workflow: await inspectWorkflow(settings, id!) };
    const revision = option(arguments_, '--revision'); const commandId = option(arguments_, '--command-id');
    if (!revision || !commandId) throw usage(`${command} requires --revision and --command-id.`);
    if (command === 'workflow-cancel') return { status: 'succeeded', workflow: await cancelWorkflow(settings, { id: id!, revision: Number(revision), commandId }) };
    if (command === 'workflow-resume') return { status: 'succeeded', workflow: await resumeWorkflow(settings, { id: id!, revision: Number(revision), commandId }) };
    if (command === 'workflow-pause') return { status: 'succeeded', workflow: await pauseWorkflow(settings, { id: id!, revision: Number(revision), commandId }) };
    if (command === 'workflow-signal') {
      const signalId = option(arguments_, '--signal-id'); const signalName = option(arguments_, '--signal-name'); const file = option(arguments_, '--value-file');
      if (!signalId || !signalName || !file) throw usage('workflow-signal requires --signal-id, --signal-name and --value-file.');
      return { status: 'succeeded', workflow: await signalWorkflow(settings, { id: id!, revision: Number(revision), commandId, signalId, signalName,
        value: await signalFile(file) }) };
    }
    const nodeId = option(arguments_, '--node'); const approvalDigest = option(arguments_, '--digest'); const childRunId = option(arguments_, '--child-id');
    if (!nodeId || !approvalDigest) throw usage('workflow-approve requires --node and --digest.');
    return { status: 'succeeded', workflow: await approveWorkflow(settings, { id: id!, revision: Number(revision), commandId, nodeId, approvalDigest,
      ...(childRunId === undefined ? {} : { childRunId }) }) };
  }
  // The unknown word is not echoed back: it could be a credential pasted in the wrong place.
  throw usage('Unknown command. Run mayura --help to see the commands.');
}

try {
  const argumentsWithoutJson = rawArguments.filter(argument => argument !== '--json');
  const result = await main(argumentsWithoutJson) as { readonly status?: string; readonly rendered?: boolean };
  if (result?.status === 'help') console.log(help(json ? paint(false) : out));
  // The version is printed plainly, as other CLIs do, so scripts can read it; --json gives the JSON document.
  else if (typeof (result as { version?: unknown })?.version === 'string' && !json) console.log((result as { version: string }).version);
  else if (result?.rendered) { if (json) console.log(JSON.stringify({ status: result.status }, null, 2)); }
  else console.log(human ? render(argumentsWithoutJson[0] ?? '', result, out, shownPath) : JSON.stringify(result, null, 2));
} catch (error) {
  const failure = publicError(error, 'INVALID_INPUT');
  console.error(!json && process.stderr.isTTY === true ? renderError(failure, err) : JSON.stringify({ status: 'failed', error: failure }));
  process.exitCode = 1;
}
