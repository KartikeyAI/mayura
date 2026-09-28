// The interactive `mayura init`: a terminal wizard over the same plan-then-apply initializer the flags use. It is
// loaded only when a person runs `mayura init` with no options in a terminal, so scripts never load the prompt library.
import { relative, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { applyProjectPlan, planProject, planStarter, starters, templates, type InitPlan, type StarterInitPlan, type StarterName, type TemplateName } from './index.js';
import { nextSteps, wrap, type Paint } from './output.js';
import { azureEndpoint, dollarsToMicros, endpointProblem, modelPattern, PROVIDERS, providerIdPattern, validKey, writeProviderEnvironment, type ProviderChoice } from './providers.js';

/** The part of a description before its first colon or full stop: short enough for a menu hint. */
const summary = (description: string): string => description.split(/[:.]/u)[0]!.trim();
const shown = (directory: string): string => { const path = relative(process.cwd(), directory) || '.'; return path.startsWith('..') ? directory : `./${path.replaceAll('\\', '/')}`; };

/** Streams to prompt on; the process's terminal by default. Tests drive the wizard through these. */
export interface WizardIo { readonly input?: Readable; readonly output?: Writable }
/** An extra step after the files are written, shown with its own spinner; `installs` drops `npm install` from the next steps. */
export interface WizardAfterWrite { readonly label: string; readonly installs: boolean; run(directory: string): Promise<string> }

export async function initWizard(p: Paint, io: WizardIo = {}, afterWrite?: WizardAfterWrite): Promise<{ readonly status: 'succeeded' | 'cancelled'; readonly plan?: InitPlan | StarterInitPlan }> {
  const prompts = await import('@clack/prompts');
  const cancelled = (): { readonly status: 'cancelled' } => { prompts.cancel('Nothing was created.', io); return { status: 'cancelled' }; };
  prompts.intro(p.bold(' Create a Mayura project '), io);

  const kind = await prompts.select({ ...io, message: 'Start from', options: [
    { value: 'starter' as const, label: 'A starter', hint: 'a complete project with tests: a server app or a command-line assistant' },
    { value: 'template' as const, label: 'A template', hint: 'one small, single-purpose example' },
  ] });
  if (prompts.isCancel(kind)) return cancelled();
  const catalog = kind === 'starter' ? starters() : templates();
  const name = await prompts.select({ ...io, message: kind === 'starter' ? 'Which starter?' : 'Which template?',
    options: catalog.map(item => ({ value: item.name as string, label: item.name, hint: summary(item.description) })) });
  if (prompts.isCancel(name)) return cancelled();
  prompts.log.message(p.dim(wrap(catalog.find(item => item.name === name)!.description, 76, '')), io);

  // Starters run on real models once configured; templates use fixtures and need no provider.
  let provider: ProviderChoice | undefined; let providerLabel = '';
  if (kind === 'starter') {
    const chosen = await prompts.select({ ...io, message: 'Which model provider?', initialValue: 'offline', maxItems: 8,
      options: PROVIDERS.map(item => ({ value: item.id, label: item.label, hint: item.hint })) });
    if (prompts.isCancel(chosen)) return cancelled();
    const details = PROVIDERS.find(item => item.id === chosen)!;
    if (details.provider) {
      providerLabel = details.label;
      // OpenAI-compatible: a preset endpoint, or the pieces of one.
      let compatible: ProviderChoice['compatible'];
      if (details.provider === 'compatible') {
        let endpoint = details.endpoint; let id = details.id;
        if (details.ask === 'azure') {
          const resource = await prompts.text({ ...io, message: 'Azure OpenAI resource name', placeholder: 'the <resource> in https://<resource>.openai.azure.com',
            validate: value => /^[a-z0-9][a-z0-9-]{1,62}$/u.test(value ?? '') ? undefined : 'Enter the resource name: lower-case letters, digits and dashes.' });
          if (prompts.isCancel(resource)) return cancelled();
          const deployment = await prompts.text({ ...io, message: 'Deployment name', placeholder: 'the deployment you created for the model',
            validate: value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value ?? '') ? undefined : 'Enter the deployment name.' });
          if (prompts.isCancel(deployment)) return cancelled();
          const version = await prompts.text({ ...io, message: 'API version', placeholder: 'as shown in your Azure portal, such as 2024-10-21',
            validate: value => /^[0-9A-Za-z.-]{1,32}$/u.test(value ?? '') ? undefined : 'Enter the api-version, such as 2024-10-21.' });
          if (prompts.isCancel(version)) return cancelled();
          endpoint = azureEndpoint(resource, deployment, version);
        } else if (details.ask === 'other') {
          const typed = await prompts.text({ ...io, message: 'Chat-completions endpoint', placeholder: 'https://api.example.com/v1/chat/completions',
            validate: value => endpointProblem(value) });
          if (prompts.isCancel(typed)) return cancelled();
          endpoint = typed.trim();
          const suggested = new URL(endpoint).hostname.split('.').find(part => !['api', 'www'].includes(part))?.replace(/[^a-z0-9-]/gu, '').slice(0, 40) || 'custom';
          const named = await prompts.text({ ...io, message: 'A short id for this provider', placeholder: suggested, defaultValue: suggested,
            validate: value => providerIdPattern.test(value || suggested) ? undefined : 'Use lower-case letters, digits and dashes, such as groq.' });
          if (prompts.isCancel(named)) return cancelled();
          id = named || suggested;
        }
        compatible = { id, endpoint: endpoint!, auth: details.auth ?? 'bearer' };
      }
      const model = await prompts.text({ ...io, message: `${details.label} model`, placeholder: details.defaultModel ?? 'the model id from your account',
        ...(details.defaultModel ? { defaultValue: details.defaultModel } : {}),
        validate: value => (value || details.defaultModel) && modelPattern.test(value || details.defaultModel!) ? undefined : 'Enter a model id, such as the one in your provider dashboard.' });
      if (prompts.isCancel(model)) return cancelled();
      // Masked, and written only to the project's .env: never printed, logged or put in the plan.
      const apiKey = await prompts.password({ ...io, message: `${details.label} API key`, mask: '•',
        validate: value => validKey(value) ? undefined : 'Paste the key: at least 8 visible characters, no spaces.' });
      if (prompts.isCancel(apiKey)) return cancelled();
      prompts.log.message(p.dim(wrap('Mayura accounts every call conservatively, so it needs your prices (from the provider\'s pricing page) and a spending cap.', 76, '')), io);
      const price = async (message: string, defaultValue?: string): Promise<number | symbol> => {
        const typed = await prompts.text({ ...io, message, placeholder: defaultValue ?? 'e.g. 3 or 0.25', ...(defaultValue ? { defaultValue } : {}),
          validate: value => dollarsToMicros(value || defaultValue) === undefined ? 'Enter a positive amount in dollars, such as 3 or 0.25.' : undefined });
        return prompts.isCancel(typed) ? typed : dollarsToMicros(typed || defaultValue)!;
      };
      const input = await price('Input price, $ per million tokens'); if (typeof input === 'symbol') return cancelled();
      const output = await price('Output price, $ per million tokens'); if (typeof output === 'symbol') return cancelled();
      const call = await price('Most one model call may cost, $', '0.05'); if (typeof call === 'symbol') return cancelled();
      const run = await price('Most one agent run may cost, $', '0.50'); if (typeof run === 'symbol') return cancelled();
      provider = { provider: details.provider, apiKey, model: model || details.defaultModel!, ...(compatible ? { compatible } : {}),
        inputMicrosPerMillionTokens: input, outputMicrosPerMillionTokens: output, maxCallCostMicros: call, maxRunCostMicros: Math.max(run, call) };
    }
  }

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
  if (provider) {
    const written = await writeProviderEnvironment(directory, provider);
    prompts.log.success(written === 'written' ? `Saved your ${providerLabel} settings and key to .env (ignored by git)`
      : '.env already exists, so it was left as it is; add the provider settings to it yourself (see .env.example)', io);
  }
  if (afterWrite) {
    const step = prompts.spinner(io.output ? { output: io.output } : {}); step.start(afterWrite.label);
    try { step.stop(await afterWrite.run(directory)); } catch (error) { step.error(`${afterWrite.label} failed.`); throw error; }
  }
  const steps = nextSteps(kind, shown(directory)).filter(step => !(afterWrite?.installs && step === 'npm install'));
  prompts.note(steps.map(step => p.cyan(step)).join('\n'), 'Next steps', io);
  prompts.outro(kind === 'starter' ? `Open the README for a tour of the ${name} starter.` : 'Done.', io);
  return { status: 'succeeded', plan };
}
