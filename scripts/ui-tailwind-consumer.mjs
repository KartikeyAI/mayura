import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const toolchain = createRequire(new URL('../extensions/ui/package.json', import.meta.url));
const { compile } = toolchain('@tailwindcss/node');
const { Scanner } = toolchain('@tailwindcss/oxide');
const postcss = toolchain('postcss');

/** Compile CSS using the consumer's own entry file, installed Tailwind, and detected sources. */
export async function compileConsumerUiCss(app, entry) {
  const consumer = createRequire(join(app, 'package.json'));
  const compiler = await compile(await readFile(entry, 'utf8'), {
    base: dirname(entry),
    from: entry,
    async customCssResolver(id) {
      if (id === 'tailwindcss') return consumer.resolve('tailwindcss/index.css');
      if (id === '@mayurajs/ui/tailwind.css') return consumer.resolve(id);
    },
    onDependency() {},
  });
  const sources = compiler.root === 'none' ? compiler.sources
    : [compiler.root ?? { base: app, pattern: '**/*', negated: false }, ...compiler.sources];
  return compiler.build(new Scanner({ sources }).scan());
}

export function verifyConsumerUiCss(css) {
  const sheet = postcss.parse(css);
  const themes = [];
  sheet.walkDecls('--color-canvas', declaration => themes.push(declaration.parent.selector));
  assert.deepEqual(themes.sort(), ['.mayura-ui', '.mayura-ui[data-theme="dark"]'],
    'Each theme must be scoped to UiRoot and installed once.');
  assert.match(css, /field-sizing:\s*content/u, 'Tailwind must generate the installed composer utility.');
}
