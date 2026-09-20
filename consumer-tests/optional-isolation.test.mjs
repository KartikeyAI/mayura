import { registerHooks, isBuiltin } from 'node:module';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Artifacts live under the workspace. Block Node's otherwise valid ancestor node_modules fallback.
const root = realpathSync(process.cwd());
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (isBuiltin(resolved.url)) return resolved;
    if (resolved.url.startsWith('file:')) {
      const path = relative(root, realpathSync(fileURLToPath(resolved.url)));
      if (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)) return resolved;
    }
    const error = new Error('Module is unavailable in this isolated packed consumer.');
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  },
});
