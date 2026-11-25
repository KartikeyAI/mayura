import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleTheme, renderUiCss, uiFoundation } from '../styles/foundation.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const styleRoot = join(packageRoot, 'styles');
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const exampleRoot = join(repositoryRoot, 'examples', 'ui-ag-ui-prototype');
const packageOutput = join(packageRoot, 'dist', 'styles.css');
const exampleOutput = join(exampleRoot, '.generated', 'shell.css');

/** Compile the scoped Mayura stylesheet with the calling project's Tailwind toolchain. */
export async function compileUiStyles({ toolchainFrom = import.meta.url, example = false } = {}) {
  const toolchain = createRequire(toolchainFrom);
  const { compile, optimize } = toolchain('@tailwindcss/node');
  const { Scanner } = toolchain('@tailwindcss/oxide');
  const postcss = toolchain('postcss');

  const input = join(styleRoot, example ? 'example.css' : 'index.css');
  const source = example
    ? `@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities) source(none);
@import "../../../examples/ui-ag-ui-prototype/src/shell.css";
${renderUiCss(exampleTheme)}`
    : (await readFile(input, 'utf8')) + '\n' + renderUiCss(uiFoundation);
  const compiler = await compile(source, {
    base: styleRoot,
    from: input,
    async customCssResolver(id) {
      // The website has its own dependency installation. Resolve Tailwind there while keeping relative CSS imports local.
      if (id === 'tailwindcss') return toolchain.resolve('tailwindcss/index.css');
      if (id.startsWith('tailwindcss/')) return toolchain.resolve(id);
    },
    onDependency() {},
  });
  const scanner = new Scanner({
    sources: [example
      ? { base: join(exampleRoot, 'src'), pattern: 'app.tsx', negated: false }
      : { base: join(packageRoot, 'src'), pattern: '**/*.{ts,tsx}', negated: false }],
  });
  const sheet = postcss.parse(compiler.build(scanner.scan().sort()));
  namespaceSheet(sheet);
  return optimize(sheet.toString().replaceAll('--tw-', '--mayura-ui-tw-'), {
    file: example ? exampleOutput : packageOutput,
    minify: true,
  }).code;
}

// Namespace all layers and registered properties as well as selectors so two Tailwind builds can coexist.
function namespaceSheet(sheet) {
  sheet.walkAtRules('layer', rule => {
    if (rule.params) rule.params = rule.params.split(',').map(layer => 'mayura-ui.' + layer.trim()).join(', ');
  });
  const keyframes = new Map();
  sheet.walkAtRules('keyframes', rule => {
    const key = rule.params.trim();
    const renamed = key.startsWith('mayura-ui-') ? key : 'mayura-ui-' + key;
    keyframes.set(key, renamed);
    rule.params = renamed;
  });
  sheet.walkDecls(/^(?:animation(?:-name)?|--animate-.+)$/u, declaration => {
    declaration.value = declaration.value.replace(/[-\w]+/gu, token => keyframes.get(token) ?? token);
  });
  const originalRoot = /^(?::(?:root|host)|html|body)(?![-\w])/u;
  sheet.walkRules(rule => {
    // Descendant CSS nesting (&) already inherits the qualified outer rule.
    for (let ancestor = rule.parent; ancestor && ancestor.type !== 'root'; ancestor = ancestor.parent) {
      if (ancestor.type === 'rule' || (ancestor.type === 'atrule' && ancestor.name.endsWith('keyframes'))) return;
    }
    rule.selectors = [...new Set(rule.selectors.map(selector => {
      if (/^\.mayura-ui(?![-\w])/u.test(selector)) return selector;
      if (originalRoot.test(selector)) return selector.replace(originalRoot, ':where(.mayura-ui)');
      if (selector === '*') return ':where(.mayura-ui, .mayura-ui *)';
      return ':where(.mayura-ui) ' + selector;
    }))];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const example = process.argv[2] === '--example';
  if (process.argv.length !== (example ? 3 : 2)) throw new Error('Usage: node build-styles.mjs [--example]');

  const output = example ? exampleOutput : packageOutput;
  const css = await compileUiStyles({ example });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, css);
  if (!example) {
    const tailwind = join(packageRoot, 'dist', 'tailwind.css');
    await Promise.all([
      writeFile(output + '.d.ts', 'export {};\n'),
      writeFile(tailwind, '@source "../src";\n\n' + renderUiCss(uiFoundation)),
      writeFile(tailwind + '.d.ts', 'export {};\n'),
    ]);
  }
  console.log('Built ' + (example ? 'the Mayura UI example stylesheet.' : '@mayurajs/ui styles.css.'));
}
