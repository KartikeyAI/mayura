/**
 * The AGENTS.md written into every new project: it points an AI coding assistant at the documentation for the exact
 * Mayura version installed (shipped inside the package), and states the rules assistants most often get wrong.
 * CLAUDE.md imports it, for assistants that read that file instead.
 */
export function agentGuide(options: { readonly kind: 'starter' | 'template'; readonly scripts: Readonly<Record<string, string>> }): string {
  const scripts = Object.entries(options.scripts).map(([name, command]) => `- \`npm run ${name}\`: \`${command}\``);
  return [
    '# AGENTS.md',
    '',
    'This project is built with [Mayura](https://github.com/KartikeyAI/mayura) (`mayura` on npm), a TypeScript framework',
    'for AI agents, typed tools and durable workflows.',
    '',
    '## Mayura documentation',
    '',
    'Read the documentation for the version installed here instead of relying on memory; the API may differ from what',
    'you have seen before:',
    '',
    '- `node_modules/mayura/docs/README.md`: the index of every page (guides, concepts, CLI, entry points).',
    '- `node_modules/mayura/llms-full.txt`: all of the documentation in one file.',
    '- `node_modules/mayura/lib/<entry point>/dist/*.d.ts`: the exact types, with doc comments.',
    '',
    '## This project',
    '',
    options.kind === 'starter'
      ? '`README.md` explains what this starter does, where everything is, and how to make it yours.'
      : '`README.md` describes this template; the code is in `src/index.ts`.',
    '',
    ...(scripts.length ? ['Scripts:', '', ...scripts, ''] : []),
    '## Rules',
    '',
    '- Import from `mayura` or `mayura/<entry point>` (such as `mayura/provider-openai`), never from `@mayura/...`.',
    '- Nothing is allowed by default. Grant what a run needs in `createRuntime({ permissions: { allow: [...] } })`:',
    '  `model:<adapter id>`, `tool:<tool id>`, `effect:<read|write|host>` for tools with effects, and every',
    '  capability a tool declares.',
    '- Costs are in micros (1,000,000 = $1). A run may spend nothing until `limits.maxCostMicros` is set, and each',
    '  model adapter needs its prices and a per-call `maxCostMicros`.',
    '- Mayura generates the JSON Schemas model providers need from Zod schemas. Providers accept only strict schemas:',
    '  use `.nullable()`, not `.optional()` or `.default()`, and no `z.record`; `defineAgent` names any field to fix.',
    '- Check `result.status` before reading `result.output`. `outcome_unknown` means a side effect may have happened:',
    '  reconcile it, never retry it blindly.',
    '- Never write API keys into code or commit `.env`. `mayura dev` loads `.env` for local development.',
    '- Test agents offline with `scriptedModel` from `mayura/testing`; tests must not need a network or an API key.',
    '',
  ].join('\n');
}
