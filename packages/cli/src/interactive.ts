// The interactive `mayura init`: a terminal wizard over the same plan-then-apply initializer the flags use. It is
// loaded only when a person runs `mayura init` with no options in a terminal, so scripts never load the prompt library.
import { relative, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { applyProjectPlan, planProject, planStarter, starters, templates, type InitPlan, type StarterInitPlan, type StarterName, type TemplateName } from './index.js';
import { nextSteps, wrap, type Paint } from './output.js';

/** The part of a description before its first colon or full stop: short enough for a menu hint. */
const summary = (description: string): string => description.split(/[:.]/u)[0]!.trim();
const shown = (directory: string): string => { const path = relative(process.cwd(), directory) || '.'; return path.startsWith('..') ? directory : `./${path.replaceAll('\\', '/')}`; };

/** Streams to prompt on; the process's terminal by default. Tests drive the wizard through these. */
export interface WizardIo { readonly input?: Readable; readonly output?: Writable }

export async function initWizard(p: Paint, io: WizardIo = {}): Promise<{ readonly status: 'succeeded' | 'cancelled'; readonly plan?: InitPlan | StarterInitPlan }> {
  const prompts = await import('@clack/prompts');
  const cancelled = (): { readonly status: 'cancelled' } => { prompts.cancel('Nothing was created.', io); return { status: 'cancelled' }; };
  prompts.intro(p.bold(' Create a Mayura project '), io);

  const kind = await prompts.select({ ...io, message: 'Start from', options: [
    { value: 'starter' as const, label: 'A starter', hint: 'a complete app: server, worker, operator console, tests' },
    { value: 'template' as const, label: 'A template', hint: 'one small, single-purpose example' },
  ] });
  if (prompts.isCancel(kind)) return cancelled();
  const catalog = kind === 'starter' ? starters() : templates();
  const name = await prompts.select({ ...io, message: kind === 'starter' ? 'Which starter?' : 'Which template?',
    options: catalog.map(item => ({ value: item.name as string, label: item.name, hint: summary(item.description) })) });
  if (prompts.isCancel(name)) return cancelled();
  prompts.log.message(p.dim(wrap(catalog.find(item => item.name === name)!.description, 76, '')), io);

  const answer = await prompts.text({ ...io, message: 'Where should it go?', placeholder: `./${name}`, defaultValue: `./${name}`,
    validate: value => value !== undefined && /[\0\r\n]/u.test(value) ? 'Use a plain directory path.' : undefined });
  if (prompts.isCancel(answer)) return cancelled();
  const directory = resolve(answer || `./${name}`);

  let plan: InitPlan | StarterInitPlan;
  try { plan = kind === 'starter' ? await planStarter(name as StarterName, directory) : await planProject(name as TemplateName, directory); }
  catch (error) { prompts.cancel(error instanceof Error ? error.message : 'The project could not be planned.', io); return { status: 'cancelled' }; }
  const creates = plan.changes.filter(change => change.operation === 'create');
  const replaces = plan.changes.filter(change => change.operation === 'replace');
  const lines = [`${creates.length} new file${creates.length === 1 ? '' : 's'} in ${shown(directory)}`];
  if (replaces.length > 0) lines.push('', p.yellow(`These existing files would be replaced:`), ...replaces.slice(0, 12).map(change => p.yellow(`  ~ ${change.path}`)),
    ...(replaces.length > 12 ? [p.yellow(`  … and ${replaces.length - 12} more`)] : []));
  if (creates.length + replaces.length === 0) { prompts.outro(`${shown(directory)} already matches the ${name} ${kind}; nothing to write.`, io); return { status: 'succeeded', plan }; }
  prompts.note(lines.join('\n'), 'Plan', io);

  // Replacing files needs an explicit yes, and defaults to no. The person has just seen exactly which files.
  const go = await prompts.confirm({ ...io, message: replaces.length > 0 ? `Replace ${replaces.length} existing file${replaces.length === 1 ? '' : 's'} and write the rest?` : 'Create the project?',
    initialValue: replaces.length === 0 });
  if (prompts.isCancel(go) || !go) return cancelled();

  const progress = prompts.spinner(io.output ? { output: io.output } : {}); progress.start('Writing files');
  try { await applyProjectPlan(plan, replaces.length > 0 ? { confirmation: plan.digest } : {}); }
  catch (error) { progress.error('Nothing was written.'); throw error; }
  progress.stop(`Wrote ${creates.length + replaces.length} files`);
  prompts.note(nextSteps(kind, shown(directory)).map(step => p.cyan(step)).join('\n'), 'Next steps', io);
  prompts.outro(kind === 'starter' ? `Open the README for a tour of the ${name} starter.` : 'Done.', io);
  return { status: 'succeeded', plan };
}
