#!/usr/bin/env node
import { resolve } from 'node:path';
import { publicError } from '@mayura/core';
import { applyProjectPlan, planProject, readProject, templates, TEMPLATE_NAMES, type TemplateName } from './index.js';

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
  throw new Error('Use: mayura templates | init | validate | inspect');
}

try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
catch (error) { console.error(JSON.stringify({ status: 'failed', error: publicError(error, 'INVALID_INPUT') })); process.exitCode = 1; }
