// Build the public shadcn registry from the standalone UI sources and scoped stylesheet.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectory = join(root, 'extensions', 'ui', 'src');
const schema = 'https://ui.shadcn.com/schema/';

const modules = [
  'ag-ui-protocol.ts', 'ag-ui.ts', 'artifacts.tsx', 'composer.tsx', 'draft-context.ts', 'index.ts',
  'inspector.tsx', 'message-actions.tsx', 'run-activity.tsx', 'thread-history.tsx', 'ui-root.tsx', 'ui.tsx', 'voice.tsx',
];

const entries = [
  { name: 'ui', title: 'Mayura UI', description: 'The full agent interface kit with the AG-UI React hook and scoped styles.', roots: modules },
  { name: 'composer', title: 'Composer', description: 'Agent input with editable quotes, file context, and voice controls.', roots: ['composer.tsx'] },
  { name: 'thread-history', title: 'Thread history', description: 'Search and reopen threads, with visible pending approvals.', roots: ['thread-history.tsx'] },
  { name: 'reply', title: 'Reply and sources', description: 'Render reply text, exact citation excerpts, and message actions.', roots: ['ui.tsx', 'message-actions.tsx', 'inspector.tsx'] },
  { name: 'artifacts', title: 'Artifacts', description: 'Open chart, audio, video, and link artifacts in a responsive inspector.', roots: ['artifacts.tsx', 'inspector.tsx'] },
  { name: 'approvals', title: 'Approval and change review', description: 'Show exact tool input and proposed document changes before an approval decision.', roots: ['ui.tsx'] },
  { name: 'ag-ui', title: 'AG-UI conversation', description: 'Use a caller-owned transport for streaming replies, thread history, and approval interrupts.', roots: ['ag-ui.ts'] },
  { name: 'run-activity', title: 'Run activity', description: 'Show the state of steps and tools in an expandable run timeline.', roots: ['run-activity.tsx'] },
];

// Follow static value and type references while retaining the package's NodeNext .js specifiers.
const importSources = /^\s*(?:(?:import|export)\b[^;]*?\bfrom\s*|import\s*)['"]([^'"\r\n]+)['"]/gmu;
const moduleBySpecifier = new Map(modules.map(name => ['./' + name.replace(/\.tsx?$/u, '.js'), name]));

function dependenciesOf(name, content) {
  const dependencies = [];
  for (const [, specifier] of content.matchAll(importSources)) {
    if (specifier === 'react') continue;
    const dependency = moduleBySpecifier.get(specifier);
    if (!dependency) throw new Error(`Unhandled registry import ${specifier} in ${name}.`);
    dependencies.push(dependency);
  }
  return dependencies;
}

function registryFile(name, content, path = 'extensions/ui/src/' + name) {
  return { path, type: 'registry:file', target: '@ui/mayura/' + name, content };
}

/** Publish independently installable items. The shadcn CLI chooses the project's configured UI directory. */
export async function writeUiRegistry(outputDirectory, css) {
  if (typeof css !== 'string' || !css.trim()) throw new Error('The Mayura UI registry needs its compiled stylesheet.');
  const files = new Map(await Promise.all(modules.map(async name => {
    const content = await readFile(join(sourceDirectory, name), 'utf8');
    return [name, { file: registryFile(name, content), imports: dependenciesOf(name, content) }];
  })));
  const shared = [
    registryFile('styles.css', css, 'extensions/ui/dist/styles.css'),
    registryFile('styles.d.css.ts', 'export {};\n', 'extensions/ui/dist/styles.d.css.ts'),
    ...await Promise.all(['LICENSE', 'NOTICE'].map(async name => registryFile(name, await readFile(join(root, name), 'utf8'), name))),
  ];
  const items = entries.map(({ roots, ...entry }) => {
    const selected = new Set();
    function visit(name) {
      if (selected.has(name)) return;
      selected.add(name);
      for (const dependency of files.get(name).imports) visit(dependency);
    }
    for (const name of ['ui-root.tsx', ...roots]) visit(name);
    return {
      ...entry, type: 'registry:block',
      files: [...[...selected].sort().map(name => files.get(name).file), ...shared],
    };
  });
  const catalog = {
    $schema: schema + 'registry.json',
    name: 'mayura',
    homepage: 'https://mayurajs.com',
    items: items.map(item => ({ ...item, files: item.files.map(({ content, ...file }) => file) })),
  };

  await mkdir(outputDirectory, { recursive: true });
  const write = (name, value) => writeFile(join(outputDirectory, name + '.json'), JSON.stringify(value, null, 2) + '\n');
  await Promise.all([
    write('registry', catalog),
    ...items.map(item => write(item.name, { $schema: schema + 'registry-item.json', ...item })),
  ]);
  return { directory: outputDirectory, items: items.map(item => item.name) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/ui-registry.mjs <output-directory>');
  const css = await readFile(join(root, 'extensions', 'ui', 'dist', 'styles.css'), 'utf8');
  const result = await writeUiRegistry(resolve(process.argv[2]), css);
  console.log(JSON.stringify(result));
}
