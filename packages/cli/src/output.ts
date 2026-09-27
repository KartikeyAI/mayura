// Human-readable rendering for the terminal. The CLI prints this only when stdout is a terminal and `--json` is not
// given; piped output stays the exact JSON documents scripts rely on. Nothing here prints credentials: results never
// contain them, and tokens only ever arrive through --token-stdin.

/** Colour only for a real terminal that has not opted out (NO_COLOR, TERM=dumb); FORCE_COLOR turns it on. */
export function colourEnabled(stream: { readonly isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return true;
  return stream.isTTY === true && env['TERM'] !== 'dumb';
}

export interface Paint {
  readonly bold: (text: string) => string; readonly dim: (text: string) => string; readonly red: (text: string) => string;
  readonly green: (text: string) => string; readonly yellow: (text: string) => string; readonly cyan: (text: string) => string;
}
export function paint(enabled: boolean): Paint {
  const code = (open: number, close: number) => (text: string): string => enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return Object.freeze({ bold: code(1, 22), dim: code(2, 22), red: code(31, 39), green: code(32, 39), yellow: code(33, 39), cyan: code(36, 39) });
}

const good = new Set(['succeeded', 'ready', 'approved', 'answered', 'migrated', 'stopped', 'released', 'resumed', 'paused']);
const bad = new Set(['failed', 'blocked', 'outcome_unknown', 'unknown', 'unavailable', 'degraded', 'cancelled', 'timed_out']);
const waiting = new Set(['running', 'waiting', 'pending', 'dispatching', 'planned', 'incomplete']);
/** A coloured status label, padded to `width` before colouring so columns line up. */
function status(p: Paint, value: string, width = 0): string {
  const colour = good.has(value) ? p.green : bad.has(value) ? p.red : waiting.has(value) ? p.yellow : p.dim;
  const mark = good.has(value) ? '✔' : bad.has(value) ? '✖' : waiting.has(value) ? '●' : '○';
  const label = `${mark} ${value.replaceAll('_', ' ')}`;
  return colour(label) + ' '.repeat(Math.max(0, width - label.length));
}
const time = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/u, ' UTC');
const micros = (value: number | string): string => `${value} µ$`;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
/** Wrap at word boundaries for descriptions under a heading. */
export function wrap(text: string, width: number, indent: string): string {
  const lines: string[] = []; let line = '';
  for (const word of text.split(/\s+/u)) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map(item => `${indent}${item}`).join('\n');
}
const columns = (): number => Math.max(60, Math.min(process.stdout.columns ?? 100, 110));

type Result = Record<string, unknown>;
const record = (value: unknown): Result => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Result;
const list = (value: unknown): Result[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** The next-steps block after a project is created. */
export function nextSteps(kind: 'starter' | 'template', directory: string): string[] {
  const cd = /\s/u.test(directory) ? `cd "${directory}"` : `cd ${directory}`;
  return kind === 'starter' ? [cd, 'npm install', 'npm run dev'] : [cd, 'npm install', 'npm run build', 'npm start'];
}

function plan(p: Paint, result: Result, relative: (path: string) => string): string[] {
  const value = record(result['plan']); const changes = list(value['changes']); const applied = result['status'] === 'succeeded';
  const kind = typeof value['starter'] === 'string' ? 'starter' : 'template';
  const name = text(value['starter']) || text(value['template']); const directory = text(value['directory']);
  const count = (operation: string) => changes.filter(change => change['operation'] === operation).length;
  const created = count('create'); const replaced = count('replace'); const unchanged = count('unchanged');
  const out = [`${p.bold(applied ? 'Created' : 'Plan for')} the ${p.cyan(name)} ${kind} in ${p.bold(relative(directory))}`, ''];
  const shown = changes.filter(change => change['operation'] !== 'unchanged').slice(0, 30);
  for (const change of shown) {
    const marker = change['operation'] === 'replace' ? p.yellow('~ replace') : p.green('+ create ');
    out.push(`  ${marker} ${text(change['path'])}`);
  }
  const hidden = created + replaced - shown.length; if (hidden > 0) out.push(p.dim(`  … and ${hidden} more`));
  out.push('', `  ${[plural(created, 'file') + ' to create', replaced ? `${replaced} to replace` : '', unchanged ? `${unchanged} unchanged` : ''].filter(Boolean).join(', ')}`);
  if (applied) {
    out.push('', p.bold('Next steps'), ...nextSteps(kind, relative(directory)).map(step => `  ${p.cyan(step)}`));
  } else {
    out.push('', `Nothing is written yet. To create these files, run the same command with ${p.bold('--apply')}${replaced ? ` ${p.bold(`--confirm ${text(value['digest'])}`)}` : ''}.`);
    if (replaced) out.push(p.yellow(`Replacing existing files needs --confirm with this plan's digest, so review the ${plural(replaced, 'replacement')} above first.`));
  }
  return out;
}

function workflow(p: Paint, value: Result): string[] {
  const out = [`${p.bold(`${text(value['definitionId'])}@${text(value['definitionVersion'])}`)}  ${status(p, text(value['status']))}  ${p.dim(`revision ${text(value['revision'])}`)}`,
    p.dim(`  ${text(value['runId'])}`), ''];
  for (const step of list(value['steps'])) {
    const approval = record(step['approval']);
    out.push(`  ${status(p, text(step['status']), 26)} ${text(step['id'])} ${p.dim(text(step['kind']))}${step['childRunId'] ? p.dim(` → ${text(step['childRunId'])}`) : ''}`);
    if (approval['digest']) out.push(p.yellow(`      needs approval: --node ${text(step['id'])} --digest ${text(approval['digest'])}`));
  }
  return out;
}

/** Render one command result for a person. Unknown shapes fall back to indented JSON, never to nothing. */
export function render(command: string, result: unknown, p: Paint, relative: (path: string) => string = path => path): string {
  const value = record(result); const out: string[] = [];
  if (command === 'templates' || command === 'starters') {
    const items = list(value[command]); const width = columns();
    out.push(p.bold(command === 'starters' ? 'Starters: complete projects with a server, worker, tests and docs' : 'Templates: small single-purpose examples'), '');
    for (const item of items) out.push(`  ${p.cyan(text(item['name']))}`, wrap(text(item['description']), width - 6, '    '), '');
    out.push(`Create one with ${p.bold(`mayura init --${command === 'starters' ? 'starter' : 'template'} <name> --directory <dir>`)}, or run ${p.bold('mayura init')} to choose interactively.`);
  } else if (command === 'init') out.push(...plan(p, value, relative));
  else if (command === 'validate') out.push(`${p.green('✔')} ${p.bold(text(value['project']))} is a valid Mayura project ${p.dim(`(${text(value['template'])})`)}`);
  else if (command === 'inspect') {
    const project = record(value['project']);
    out.push(`${p.bold(text(project['name']))} ${p.dim(`(${text(project['template'])})`)}`, '');
    const definitions = list(project['definitions']); const tools = list(project['tools']);
    out.push(p.bold(`Definitions (${definitions.length})`));
    for (const item of definitions) out.push(`  ${text(item['kind']).padEnd(9)} ${p.cyan(`${text(item['id'])}@${text(item['version'])}`)} ${p.dim(text(item['source']))}`);
    out.push('', p.bold(`Tools (${tools.length})`));
    for (const item of tools) {
      const capabilities = Array.isArray(item['capabilities']) ? (item['capabilities'] as string[]).join(', ') : '';
      out.push(`  ${p.cyan(`${text(item['id'])}@${text(item['version'])}`)}  effects: ${text(item['effects'])}${capabilities ? p.dim(`  capabilities: ${capabilities}`) : ''}`);
    }
  } else if (command === 'server-health') {
    const health = record(value['health']); out.push(`Server ${status(p, text(health['status']))}`);
    for (const check of list(health['checks'])) out.push(`  ${status(p, text(check['status']), 24)} ${text(check['id'])}`);
  } else if (command === 'server-tools') {
    const page = record(value['page']); const tools = list(page['tools']);
    out.push(p.bold(plural(tools.length, 'tool')), '');
    for (const tool of tools) {
      out.push(`  ${p.cyan(`${text(tool['id'])}@${text(tool['version'])}`)}  ${p.dim(`agent ${text(tool['agentId'])}@${text(tool['agentVersion'])}`)}`,
        `    effects: ${text(tool['effects'])}, cost up to ${micros(text(tool['costMicros']))}, timeout ${text(tool['timeoutMs'])} ms`);
    }
    if (page['next'] !== null && page['next'] !== undefined) out.push('', p.dim(`More: add --after ${text(page['next'])}`));
  } else if (command === 'human-list') {
    const page = record(value['page']); const items = list(page['items']);
    out.push(p.bold(plural(items.length, 'human request')), '');
    for (const item of items) out.push(`  ${status(p, text(item['status']), 24)} ${p.cyan(text(item['id']))} ${p.dim(`${text(item['kind']).replaceAll('_', ' ')} · ${text(item['agentId'])}`)}`,
      wrap(text(item['prompt']).slice(0, 300), columns() - 8, '      '));
    if (page['next'] !== null && page['next'] !== undefined) out.push('', p.dim(`More: add --after ${text(page['next'])}`));
  } else if (command === 'human-get' || command === 'human-respond') {
    const item = record(value['request']);
    out.push(`${p.bold(text(item['id']))}  ${status(p, text(item['status']))}  ${p.dim(`${text(item['kind']).replaceAll('_', ' ')} · agent ${text(item['agentId'])}`)}`, '',
      wrap(text(item['prompt']), columns() - 4, '  '), '', p.dim(`  digest   ${text(item['digest'])}`), p.dim(`  schema   ${text(item['schemaId'])}`));
    if (typeof item['deadlineAtMs'] === 'number') out.push(p.dim(`  deadline ${time(item['deadlineAtMs'])}`));
  } else if (command === 'run-get' || command === 'run-wait') {
    const run = record(value['run']); const budget = record(run['budget']);
    out.push(`${p.bold('Run')} ${text(run['id'])}  ${status(p, text(run['status']))}`,
      `  spent ${micros(text(budget['spentMicros']))}, reserved ${micros(text(budget['reservedMicros']))}, ${plural(Number(budget['calls']), 'call')}`);
    const evidence = list(run['evidence']);
    if (evidence.length) out.push('', p.bold('Tool calls'));
    for (const entry of evidence) {
      const receipt = record(entry['receipt']);
      out.push(`  ${status(p, text(receipt['execution']), 24)} ${text(receipt['toolId'])} ${p.dim(`output ${text(receipt['disclosure'])}`)}`);
    }
  } else if (command === 'run-cancel') out.push(`${p.green('✔')} Cancellation requested for run ${text(value['id'])}`);
  else if (command === 'workflow-list') {
    const page = record(value['page']); const items = list(page['items']);
    out.push(p.bold(plural(items.length, 'workflow run')), '');
    for (const item of items) {
      const settled = typeof item['settledAtMs'] === 'number' ? p.dim(` · settled ${time(item['settledAtMs'])}`) : '';
      out.push(`  ${status(p, text(item['status']), 26)} ${p.cyan(`${text(item['definitionId'])}@${text(item['definitionVersion'])}`)} ${p.dim(`rev ${text(item['revision'])}`)}${settled}`,
        p.dim(`      ${text(item['runId'])}`));
    }
    if (page['next'] !== null && page['next'] !== undefined) out.push('', p.dim(`More: add --after ${text(page['next'])}`));
  } else if (command.startsWith('workflow-')) out.push(...workflow(p, record(value['workflow'])));
  else if (command === 'fleet-get' || command === 'fleet-hold' || command === 'fleet-release') {
    const fleet = record(value['fleet']);
    out.push(fleet['held'] === true ? p.yellow('● The fleet is held: workers start no new work.') : p.green('✔ The fleet is running.'),
      p.dim(`  generation ${text(fleet['generation'])}${typeof fleet['changedAtMs'] === 'number' ? `, changed ${time(fleet['changedAtMs'])}` : ''}`));
  } else if (command === 'fleet-sweep') {
    const outcomes = list(value['outcomes']); const counts = new Map<string, number>();
    for (const outcome of outcomes) counts.set(text(outcome['outcome']), (counts.get(text(outcome['outcome'])) ?? 0) + 1);
    out.push(`${p.bold(`Fleet ${text(value['phase'])} sweep`)}  ${status(p, text(value['status']))}  ${p.dim(plural(Number(value['pages']), 'page'))}`);
    for (const [outcome, count] of counts) out.push(`  ${String(count).padStart(5)} ${outcome.replaceAll('_', ' ')}`);
    if (value['nextCursor']) out.push('', p.yellow('Not finished. Run with --json to save nextCursor to a file, then continue with --cursor-file.'));
  } else if (command === 'migrate') out.push(`${p.green('✔')} Storage migrated`);
  else if (command === 'serve' || command === 'worker') out.push(`${p.green('✔')} Stopped`);
  else out.push(JSON.stringify(result, null, 2));
  return out.join('\n');
}

/** One line per lifecycle event while `serve` or `worker` runs in a terminal. */
export function renderLifecycle(event: { readonly event: string } & Record<string, unknown>, p: Paint): string {
  if (event.event === 'serving') return p.green('● Serving. Press Ctrl+C to stop.');
  if (event.event === 'worker-started') {
    const probe = record(event['probe']);
    return p.green(`● Worker started${probe['port'] !== undefined ? `, probes on ${text(probe['hostname'])}:${text(probe['port'])}` : ''}. Press Ctrl+C to stop.`);
  }
  if (event.event === 'stopping') return p.yellow('● Stopping… (press Ctrl+C again to force)');
  if (event.event === 'stopped') return `${p.green('✔ Stopped')}${event['drained'] === false ? p.yellow(` · ${text(event['interrupted'])} interrupted`) : ''}`;
  return JSON.stringify(event);
}

export function renderError(error: { readonly code: string; readonly message: string }, p: Paint): string {
  return `${p.red(`✖ ${error.message}`)} ${p.dim(`(${error.code})`)}`;
}

export function help(p: Paint): string {
  const row = (name: string, description: string): string => `  ${p.cyan(name.padEnd(30))} ${description}`;
  return [
    `${p.bold('mayura')} <command> [options]`, '',
    p.bold('Create'),
    row('init', 'create a project; with no options in a terminal, choose interactively'),
    row('init --starter <name> --directory <dir>', ''), row('init --template <name> --directory <dir>', 'show the plan; add --apply to write it'),
    row('starters', 'complete starter projects'), row('templates', 'small single-purpose templates'),
    row('validate --file <path>', 'check a mayura.project.json'), row('inspect --file <path>', 'list its agents, workflows and tools'), '',
    p.bold('Run an application'),
    row('serve --app <module>', 'start its server'), row('worker --app <module>', 'start its worker'), row('migrate --app <module>', 'migrate its storage'), '',
    p.bold('Operate a server') + p.dim('  (pipe the token: … | mayura <command> --url <url> --token-stdin)'),
    row('server-health, server-tools', ''), row('run-get, run-wait, run-cancel', ''), row('human-list, human-get, human-respond', ''),
    row('workflow-list [--settled]', 'active runs, or finished and unresolved ones'),
    row('workflow-get, workflow-approve', ''), row('workflow-cancel, workflow-pause, workflow-resume, workflow-signal', ''),
    row('fleet-get, fleet-hold, fleet-release, fleet-sweep', ''), '',
    p.dim('Output is readable in a terminal and JSON when piped; --json always prints JSON.'),
  ].map(line => line.trimEnd()).join('\n');
}
