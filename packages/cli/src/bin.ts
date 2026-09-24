#!/usr/bin/env node
import { resolve } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { jsonValue, publicError, type JsonValue } from '@mayura/core';
import { applyProjectPlan, inspectHumanRequest, inspectHumanRequests, inspectServerHealth, inspectServerTools, planProject, readProject,
  respondHumanRequest, templates, TEMPLATE_NAMES, type TemplateName } from './index.js';

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name); if (index < 0) return undefined;
  const value = arguments_[index + 1]; if (value === undefined || value.startsWith('--')) throw new Error(`Missing ${name}.`); return value;
}

function assertArguments(arguments_: readonly string[], valued: readonly string[], flags: readonly string[] = []): void {
  const seen = new Set<string>();
  for (let index = 1; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (seen.has(argument) || (!valued.includes(argument) && !flags.includes(argument))) throw new Error('Unknown or repeated CLI argument.');
    seen.add(argument);
    if (valued.includes(argument)) {
      const value = arguments_[++index]; if (value === undefined || value.startsWith('--')) throw new Error('CLI option value is missing.');
    }
  }
}

async function stdinToken(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('Operational credentials must be piped through stdin.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); size += bytes.byteLength;
    if (size > 8_194) throw new Error('Operational credential input is too large.'); chunks.push(bytes);
  }
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new Error('Operational credential input is invalid.'); }
  value = value.replace(/\r?\n$/u, '');
  if (!/^[\x21-\x7e]{1,8192}$/u.test(value)) throw new Error('Operational credential input is invalid.');
  return value;
}

async function responseFile(path: string): Promise<JsonValue> {
  const absolute = resolve(path); const details = await lstat(absolute);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.size > 1_048_576) throw new Error('Human response file must be a bounded regular JSON file.');
  try { return jsonValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(absolute))), { maxBytes: 1_048_576 }); }
  catch { throw new Error('Human response file must contain valid UTF-8 JSON.'); }
}

async function main(arguments_: readonly string[]): Promise<unknown> {
  const command = arguments_[0];
  if (command === 'templates') { assertArguments(arguments_, []); return { status: 'succeeded', templates: templates() }; }
  if (command === 'init') {
    assertArguments(arguments_, ['--template', '--directory', '--confirm'], ['--apply']);
    const template = option(arguments_, '--template'); const directory = option(arguments_, '--directory');
    if (!template || !TEMPLATE_NAMES.includes(template as TemplateName) || !directory) throw new Error('init requires --template and --directory.');
    const plan = await planProject(template as TemplateName, resolve(directory));
    if (!arguments_.includes('--apply') && arguments_.includes('--confirm')) throw new Error('--confirm requires --apply.');
    if (arguments_.includes('--apply')) {
      const confirmation = option(arguments_, '--confirm');
      await applyProjectPlan(plan, confirmation === undefined ? {} : { confirmation });
    }
    return { status: arguments_.includes('--apply') ? 'succeeded' : 'planned', plan };
  }
  if (command === 'validate' || command === 'inspect') {
    assertArguments(arguments_, ['--file']);
    const file = option(arguments_, '--file'); if (!file) throw new Error(`${command} requires --file.`);
    const project = await readProject(resolve(file));
    return command === 'validate' ? { status: 'succeeded', project: project.name, template: project.template }
      : { status: 'succeeded', project };
  }
  if (command === 'server-health' || command === 'server-tools') {
    assertArguments(arguments_, command === 'server-tools' ? ['--url', '--after', '--limit'] : ['--url'], ['--token-stdin']);
    const baseUrl = option(arguments_, '--url');
    if (!baseUrl || !arguments_.includes('--token-stdin')) throw new Error(`${command} requires --url and --token-stdin.`);
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
    if (!baseUrl || !arguments_.includes('--token-stdin')) throw new Error(`${command} requires --url and --token-stdin.`);
    const credential = await stdinToken(); const settings = { baseUrl, token: () => credential };
    if (command === 'human-list') {
      const after = option(arguments_, '--after'); const limit = option(arguments_, '--limit');
      return { status: 'succeeded', page: await inspectHumanRequests(settings, { ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit: Number(limit) }) }) };
    }
    const id = option(arguments_, '--id'); if (!id) throw new Error(`${command} requires --id.`);
    if (command === 'human-get') return { status: 'succeeded', request: await inspectHumanRequest(settings, id) };
    const requestDigest = option(arguments_, '--digest'); const commandId = option(arguments_, '--command-id'); const file = option(arguments_, '--response-file');
    if (!requestDigest || !commandId || !file) throw new Error('human-respond requires --digest, --command-id and --response-file.');
    return { status: 'succeeded', request: await respondHumanRequest(settings, { id, requestDigest, commandId, value: await responseFile(file) }) };
  }
  throw new Error('Use: mayura templates | init | validate | inspect | server-health | server-tools | human-list | human-get | human-respond');
}

try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
catch (error) { console.error(JSON.stringify({ status: 'failed', error: publicError(error, 'INVALID_INPUT') })); process.exitCode = 1; }
