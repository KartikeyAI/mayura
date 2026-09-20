import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

function inside(parent, child) { const path = relative(parent, child); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); }

/**
 * Audit the compiler's actual --listFiles graph, not just ambient type inclusion.
 * Consumer declarations may use only their real installed tree and the selected compiler's
 * standard library. This catches ancestor @types resolution hidden by workspace-local tests.
 */
export function assertConsumerTypeFiles({ output, application, compilerPath }) {
  assert(typeof output === 'string', 'Compiler file-list output is required.');
  const root = realpathSync(application);
  const compiler = realpathSync(compilerPath); const directory = dirname(dirname(compiler));
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'typescript', 'Compiler entry must belong to the installed TypeScript package.');
  let library = join(directory, 'lib');
  if (!existsSync(join(library, 'lib.es5.d.ts'))) {
    // TypeScript 7 ships its native compiler and default libraries in a pinned platform package.
    const name = `@typescript/typescript-${process.platform}-${process.arch}`;
    assert.equal(manifest.optionalDependencies?.[name], manifest.version, 'Unqualified native TypeScript platform package.');
    const require = createRequire(compiler);
    const packagePath = realpathSync(require.resolve(`${name}/package.json`));
    const platform = JSON.parse(readFileSync(packagePath, 'utf8'));
    assert.equal(platform.name, name); assert.equal(platform.version, manifest.version);
    library = join(dirname(packagePath), 'lib');
  }
  library = realpathSync(library);
  const files = output.trim().split(/\r?\n/).filter(Boolean);
  assert(files.length > 1, 'Compiler did not report a complete input graph.');
  let standardLibraries = 0; let consumerEntry = false;
  const entry = realpathSync(join(root, 'consumer.ts'));
  for (const path of files) {
    assert(isAbsolute(path), 'Compiler file-list contains a nonabsolute path or diagnostic.');
    const actual = realpathSync(path);
    if (inside(root, actual)) { if (actual === entry) consumerEntry = true; continue; }
    const filename = relative(library, actual);
    assert(/^lib(?:\.[A-Za-z0-9_-]+)*\.d\.ts$/.test(filename), 'Consumer types resolved outside the installed application or selected compiler standard library.');
    standardLibraries++;
  }
  assert(consumerEntry && standardLibraries > 0, 'Compiler graph must include the consumer entry and a qualified standard library.');
  return files.length;
}
