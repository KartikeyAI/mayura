import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks, isBuiltin } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, threadId } from 'node:worker_threads';

// Workers inherit this --import hook: neither JavaScript nor native bindings may fall back
// to the parent workspace. Instrumentation exists only in the disposable consumer process.
const root = realpathSync(process.cwd());
function local(path) {
  // Node passes Windows dlopen an extended-length path that realpathSync may reject.
  // Normalize only the namespace spelling; the original loader argument is untouched.
  let ordinary = path;
  if (process.platform === 'win32' && typeof path === 'string' && path.startsWith('\\\\?\\')) {
    if (/^[A-Za-z]:\\/.test(path.slice(4))) ordinary = path.slice(4);
    else if (path.startsWith('\\\\?\\UNC\\')) ordinary = `\\\\${path.slice(8)}`;
    else throw new Error('Unsupported native path namespace.');
  }
  const resolved = realpathSync(ordinary); const part = relative(root, resolved);
  assert(part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part), 'Installed consumer escaped its own dependency tree.');
  return { resolved, part: part.split(sep).join('/') };
}
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (isBuiltin(result.url)) return result;
  try { if (result.url.startsWith('file:')) { local(fileURLToPath(result.url)); return result; } } catch { /* Normalize fallback rejection. */ }
  const error = new Error('Module is unavailable in this isolated storage consumer.'); error.code = 'ERR_MODULE_NOT_FOUND'; throw error;
} });
const dlopen = process.dlopen;
process.dlopen = function (...args) {
  const path = local(args[1]);
  assert(path.part.startsWith('node_modules/better-sqlite3/prebuilds/') && path.part.endsWith('.node'), 'Unqualified native binding.');
  assert.notEqual(process.env.MAYURA_STORAGE_PROFILE, 'postgres', 'PostgreSQL-only installation must not load native code.');
  const result = Reflect.apply(dlopen, this, args);
  appendFileSync(join(root, 'native-loads.jsonl'), `${JSON.stringify({ path: path.part, isMainThread, threadId,
    sha256: createHash('sha256').update(readFileSync(path.resolved)).digest('hex') })}\n`);
  return result;
};
